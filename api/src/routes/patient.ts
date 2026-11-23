// Public patient pages for secure SMS links:  GET /p/<token>
// No login. The patient answers a check question, then sees one appointment and can confirm it
// or ask for a new time. Every response is no-store / noindex / no-referrer.
import { Router, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { audit } from "../lib/audit";
import { ah, HttpError } from "../lib/http";
import { requestReschedule } from "../services/crm";
import { notifyClinic } from "../services/notify";
import {
  checkQuestion, findLink, linkDetails, linkState, markOpened, sessionValid, verifyLink, type LinkRow,
} from "../services/patientLinks";
import { setAppointmentStatus } from "../services/scheduling";
import { PATIENT_JS, patientHtml } from "./patientPage";

export const patientRouter = Router();

patientRouter.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

const pageLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
const verifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

patientRouter.get("/assets/patient.js", (_req, res) => {
  res.type("application/javascript").send(PATIENT_JS);
});

async function loadLink(req: Request): Promise<LinkRow> {
  const link = await findLink(String(req.params.token ?? ""));
  if (!link) throw new HttpError(404, "This link is not valid.");
  return link;
}

function requireOpen(link: LinkRow) {
  const state = linkState(link);
  if (state === "expired") throw new HttpError(410, "This link has expired. Please call the office.");
  if (state === "locked") throw new HttpError(423, "This link is locked. Please call the office.");
}

async function requireSession(req: Request): Promise<LinkRow> {
  const link = await loadLink(req);
  requireOpen(link);
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!sessionValid(link, bearer)) throw new HttpError(401, "Please check your details again.");
  return link;
}

// The page itself never contains patient data: it loads, then asks the API.
patientRouter.get("/:token", pageLimiter, (_req, res) => {
  res.type("html").send(patientHtml());
});

patientRouter.get("/:token/info", pageLimiter, ah(async (req, res) => {
  const link = await loadLink(req);
  const state = linkState(link);
  if (state === "ok") await markOpened(link, req.ip ?? null);
  res.json({
    state,
    clinicName: link.clinic.name,
    clinicPhone: link.clinic.aiPhoneNumber,
    question: state === "ok" ? checkQuestion(link.patient) : null,
  });
}));

patientRouter.post("/:token/verify", verifyLimiter, ah(async (req, res) => {
  const { answer } = z.object({ answer: z.string().min(1).max(100) }).parse(req.body);
  const link = await loadLink(req);
  requireOpen(link);
  const r = await verifyLink(link, answer, req.ip ?? null);
  if (!r.ok) {
    if (r.locked) {
      await notifyClinic(link.clinicId, "SMS", "Patient link locked", "A secure appointment link was locked after too many wrong answers.", "/notifications");
      throw new HttpError(423, "This link is locked. Please call the office.");
    }
    return res.status(400).json({ error: `That doesn't match our records. ${r.attemptsLeft} ${r.attemptsLeft === 1 ? "try" : "tries"} left.`, attemptsLeft: r.attemptsLeft });
  }
  const fresh = (await findLink(String(req.params.token)))!;
  res.json({ session: r.session, details: await linkDetails(fresh) });
}));

patientRouter.get("/:token/details", pageLimiter, ah(async (req, res) => {
  const link = await requireSession(req);
  await audit(null, { action: "patient_link.view", entity: "patient_link", entityId: link.id, clinicId: link.clinicId, meta: { ip: req.ip } }, "patient");
  res.json(await linkDetails(link));
}));

patientRouter.post("/:token/confirm", pageLimiter, ah(async (req, res) => {
  const link = await requireSession(req);
  const details = await linkDetails(link);
  if (!link.appointmentId || !details.appointment?.canConfirm) throw new HttpError(409, "This appointment can't be confirmed online. Please call the office.");
  await setAppointmentStatus(link.clinicId, link.appointmentId, "CONFIRMED");
  await audit(null, { action: "patient_link.confirm", entity: "appointment", entityId: link.appointmentId, clinicId: link.clinicId, meta: { ip: req.ip } }, "patient");
  res.json(await linkDetails(link));
}));

patientRouter.post("/:token/reschedule", pageLimiter, ah(async (req, res) => {
  const link = await requireSession(req);
  const details = await linkDetails(link);
  if (!details.appointment?.canReschedule) throw new HttpError(409, "Please call the office to change this appointment.");
  await requestReschedule(link.clinicId, link.patient, "LINK");
  await notifyClinic(link.clinicId, "NEW_LEAD", "Reschedule request", "A patient asked for a new time from their appointment link. Open the CRM to follow up.", "/crm");
  await audit(null, { action: "patient_link.reschedule_request", entity: "appointment", entityId: link.appointmentId ?? undefined, clinicId: link.clinicId, meta: { ip: req.ip } }, "patient");
  res.json({ ok: true });
}));
