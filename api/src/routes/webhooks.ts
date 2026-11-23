// Plivo webhooks: incoming SMS replies (confirm, opt-out, feedback) and delivery reports.
import { Router, type Request } from "express";
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import * as plivo from "plivo";
import { config } from "../config";
import { db, schema } from "../db";
import { audit } from "../lib/audit";
import { encrypt } from "../lib/crypto";
import { ah, HttpError } from "../lib/http";
import { formatUsPhone, normalizeUsPhone } from "../lib/phone";
import { speakable } from "../lib/time";
import { requestReschedule } from "../services/crm";
import { notifyClinic } from "../services/notify";
import { setAppointmentStatus, upsertPatient } from "../services/scheduling";
import { sendSms } from "../services/sms";

export const webhookRouter = Router();

function verifyPlivo(req: Request) {
  if (config.dryRun) return; // local dev without Plivo credentials
  const sig = req.headers["x-plivo-signature-v3"] as string | undefined;
  const nonce = req.headers["x-plivo-signature-v3-nonce"] as string | undefined;
  if (!sig || !nonce) throw new HttpError(401, "Missing Plivo signature");
  const url = `${config.publicApiUrl}${req.originalUrl}`;
  const ok = plivo.validateV3Signature(req.method, url, nonce, config.plivo.authToken, sig, req.body ?? {});
  if (!ok) throw new HttpError(401, "Bad Plivo signature");
}

const STOP_WORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"];
const START_WORDS = ["START", "UNSTOP", "YES START", "SUBSCRIBE"];
const CONFIRM_WORDS = ["C", "CONFIRM", "CONFIRMED", "YES", "Y"];
const RESCHEDULE_WORDS = ["R", "RESCHEDULE", "CHANGE"];

webhookRouter.post("/plivo/sms", ah(async (req, res) => {
  verifyPlivo(req);
  const from = normalizeUsPhone(req.body.From);
  const to = normalizeUsPhone(req.body.To);
  const text = String(req.body.Text ?? "").trim();
  if (!from || !to) return res.status(200).send("ignored");

  const clinic = await db.query.clinics.findFirst({ where: eq(schema.clinics.aiPhoneNumber, to) });
  if (!clinic) return res.status(200).send("ignored");
  const patient = await upsertPatient(clinic.id, from);

  await db.insert(schema.smsMessages).values({
    clinicId: clinic.id, patientId: patient.id, direction: "IN", fromNumber: from, toNumber: to,
    bodyEnc: encrypt(text)!, purpose: "REPLY", providerMessageId: req.body.MessageUUID, status: "received",
  });

  const word = text.toUpperCase().replace(/[^A-Z0-9 ]/g, "").trim();

  if (STOP_WORDS.includes(word)) {
    await db.update(schema.patients).set({ smsOptOut: true }).where(eq(schema.patients.id, patient.id));
    await audit(null, { action: "SMS_OPT_OUT", entity: "patient", entityId: patient.id, clinicId: clinic.id }, "plivo");
    await sendSms(clinic, { ...patient, smsOptOut: true }, `${clinic.name}: you're unsubscribed and won't get more texts. Reply START to resubscribe.`, "OPT_OUT", { skipConsentCheck: true });
    return res.status(200).send("ok");
  }
  if (START_WORDS.includes(word)) {
    const [p] = await db.update(schema.patients).set({ smsOptOut: false, smsConsent: true }).where(eq(schema.patients.id, patient.id)).returning();
    await audit(null, { action: "SMS_OPT_IN", entity: "patient", entityId: patient.id, clinicId: clinic.id }, "plivo");
    await sendSms(clinic, p, `${clinic.name}: you're subscribed to appointment texts again.`, "REPLY");
    return res.status(200).send("ok");
  }
  if (word === "HELP" || word === "INFO") {
    await sendSms(clinic, patient, `${clinic.name} appointment texts. Call ${formatUsPhone(clinic.aiPhoneNumber)} for help. Reply STOP to opt out.`, "REPLY", { skipConsentCheck: true });
    return res.status(200).send("ok");
  }

  const upcoming = await db.query.appointments.findFirst({
    where: and(
      eq(schema.appointments.clinicId, clinic.id),
      eq(schema.appointments.patientId, patient.id),
      gte(schema.appointments.startAt, new Date()),
      inArray(schema.appointments.status, ["BOOKED", "CONFIRMED"]),
    ),
    orderBy: asc(schema.appointments.startAt),
  });

  if (CONFIRM_WORDS.includes(word) && upcoming) {
    await setAppointmentStatus(clinic.id, upcoming.id, "CONFIRMED");
    await sendSms(clinic, patient, clinic.smsStyle === "LINK" ? "Thanks! You're confirmed. See you soon." : `Thanks! You're confirmed for ${speakable(upcoming.startAt, clinic.timezone)}.`, "CONFIRMED", { skipConsentCheck: true });
    return res.status(200).send("ok");
  }

  if (RESCHEDULE_WORDS.includes(word)) {
    await requestReschedule(clinic.id, { ...patient, phone: from }, "SMS");
    await notifyClinic(clinic.id, "NEW_LEAD", "Reschedule request", "A patient asked to reschedule by text. Open the CRM to follow up.", "/crm");
    await sendSms(clinic, patient, `No problem. Call us any time at ${formatUsPhone(clinic.aiPhoneNumber)} and our assistant will find a new time.`, "REPLY", { skipConsentCheck: true });
    return res.status(200).send("ok");
  }

  // Feedback reply: a digit 1-5 (optionally followed by a comment) after a feedback request text
  const recentFeedbackAsk = await db.query.smsMessages.findFirst({
    where: and(
      eq(schema.smsMessages.clinicId, clinic.id),
      eq(schema.smsMessages.patientId, patient.id),
      eq(schema.smsMessages.purpose, "FEEDBACK_REQUEST"),
      gte(schema.smsMessages.createdAt, new Date(Date.now() - 3 * 86400_000)),
    ),
    orderBy: desc(schema.smsMessages.createdAt),
  });
  const m = text.match(/^\s*([1-5])\b\s*[-:,.]?\s*(.*)$/s);
  if (recentFeedbackAsk && m) {
    const rating = Number(m[1]);
    const lastSeen = await db.query.appointments.findFirst({
      where: and(eq(schema.appointments.patientId, patient.id), eq(schema.appointments.status, "SHOWED")),
      orderBy: desc(schema.appointments.startAt),
    });
    await db.insert(schema.feedback).values({
      clinicId: clinic.id, patientId: patient.id, appointmentId: lastSeen?.id, rating, commentEnc: encrypt(m[2] || null), channel: "SMS",
    });
    if (rating <= 3) await notifyClinic(clinic.id, "FEEDBACK", "Low feedback score", `A patient rated their visit ${rating}/5 by text.`, "/feedback");
    await sendSms(clinic, patient, "Thank you for your feedback!", "REPLY", { skipConsentCheck: true });
    return res.status(200).send("ok");
  }

  // Anything else: hand to staff
  await notifyClinic(clinic.id, "SMS", "New text message", "A patient sent a text. Open the app to read it.", "/notifications");
  res.status(200).send("ok");
}));

webhookRouter.post("/plivo/sms-status", ah(async (req, res) => {
  verifyPlivo(req);
  const id = req.body.MessageUUID as string | undefined;
  const status = req.body.Status as string | undefined;
  if (id && status) {
    await db.update(schema.smsMessages).set({ status }).where(eq(schema.smsMessages.providerMessageId, id));
  }
  res.status(200).send("ok");
}));
