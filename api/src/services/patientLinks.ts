// Secure patient links (LINK SMS mode).
//
// The text message only says "<Clinic>: you have an appointment update. View: <link>".
// The appointment details live on our server and are shown only after the patient answers a
// check question. Rules:
//  * The token is random (144 bits) and only its SHA-256 is stored.
//  * Links expire (max 72 hours, or a few hours after the visit, whichever is first).
//  * 5 wrong answers lock the link.
//  * A correct answer opens a 15-minute session; every open, check and action is audit-logged.
import { and, eq } from "drizzle-orm";
import { config } from "../config";
import { db, schema } from "../db";
import type { Appointment, Clinic, Patient } from "../db/schema";
import { audit } from "../lib/audit";
import { randomToken, safeEqual, sha256 } from "../lib/crypto";
import { formatUsPhone } from "../lib/phone";
import { speakable } from "../lib/time";

export const LINK_MAX_HOURS = 72;
export const LINK_MAX_ATTEMPTS = 5;
export const LINK_SESSION_MINUTES = 15;

type Purpose = "BOOKED" | "REMINDER" | "CONFIRMED";

/** Create a link for one appointment and return the URL to put in the text. */
export async function createPatientLink(clinic: Clinic, patient: Patient, appt: Appointment | null, purpose: Purpose): Promise<string> {
  const token = randomToken(18); // 24 url-safe characters
  const now = Date.now();
  let expires = now + LINK_MAX_HOURS * 3600_000;
  if (appt) expires = Math.min(expires, appt.endAt.getTime() + 6 * 3600_000);
  expires = Math.max(expires, now + 3600_000); // always at least 1 hour to open it
  await db.insert(schema.patientLinks).values({
    clinicId: clinic.id,
    patientId: patient.id,
    appointmentId: appt?.id ?? null,
    purpose,
    tokenHash: sha256(token),
    expiresAt: new Date(expires),
  });
  return `${config.patientLinkBase}/p/${token}`;
}

export type LinkRow = NonNullable<Awaited<ReturnType<typeof findLink>>>;

export async function findLink(token: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  return db.query.patientLinks.findFirst({
    where: eq(schema.patientLinks.tokenHash, sha256(token)),
    with: { clinic: true, patient: true, appointment: true },
  });
}

export function linkState(link: LinkRow): "ok" | "expired" | "locked" {
  if (link.lockedAt) return "locked";
  if (link.expiresAt.getTime() < Date.now()) return "expired";
  return "ok";
}

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

/** Which check question the patient gets, based on what we know about them. */
export function checkQuestion(patient: Patient): { kind: "last_name" | "first_name" | "phone4"; label: string } {
  if (norm(patient.lastName)) return { kind: "last_name", label: "Your last name" };
  if (norm(patient.firstName)) return { kind: "first_name", label: "Your first name" };
  return { kind: "phone4", label: "Last 4 digits of your phone number" };
}

function expected(patient: Patient): string {
  const q = checkQuestion(patient);
  if (q.kind === "last_name") return norm(patient.lastName);
  if (q.kind === "first_name") return norm(patient.firstName);
  return patient.phone.replace(/\D/g, "").slice(-4);
}

export async function markOpened(link: LinkRow, ip: string | null) {
  if (!link.openedAt) await db.update(schema.patientLinks).set({ openedAt: new Date() }).where(eq(schema.patientLinks.id, link.id));
  await audit(null, { action: "patient_link.open", entity: "patient_link", entityId: link.id, clinicId: link.clinicId, meta: { ip } }, "patient");
}

/** Check the answer. Returns a session token on success. */
export async function verifyLink(link: LinkRow, answer: string, ip: string | null): Promise<{ ok: true; session: string } | { ok: false; locked: boolean; attemptsLeft: number }> {
  const good = norm(answer).length > 0 && safeEqual(norm(answer), expected(link.patient));
  if (!good) {
    const failed = link.failedAttempts + 1;
    const locked = failed >= LINK_MAX_ATTEMPTS;
    await db.update(schema.patientLinks)
      .set({ failedAttempts: failed, lockedAt: locked ? new Date() : null })
      .where(eq(schema.patientLinks.id, link.id));
    await audit(null, { action: locked ? "patient_link.locked" : "patient_link.verify_failed", entity: "patient_link", entityId: link.id, clinicId: link.clinicId, meta: { ip, failed } }, "patient");
    return { ok: false, locked, attemptsLeft: Math.max(0, LINK_MAX_ATTEMPTS - failed) };
  }
  const session = randomToken(32);
  await db.update(schema.patientLinks).set({
    sessionHash: sha256(session),
    sessionExpiresAt: new Date(Date.now() + LINK_SESSION_MINUTES * 60_000),
    verifiedAt: new Date(),
    failedAttempts: 0,
  }).where(eq(schema.patientLinks.id, link.id));
  await audit(null, { action: "patient_link.verified", entity: "patient_link", entityId: link.id, clinicId: link.clinicId, meta: { ip } }, "patient");
  return { ok: true, session };
}

export function sessionValid(link: LinkRow, session: string | undefined): boolean {
  if (!session || !link.sessionHash || !link.sessionExpiresAt) return false;
  if (link.sessionExpiresAt.getTime() < Date.now()) return false;
  return safeEqual(sha256(session), link.sessionHash);
}

/** What the patient sees after the check. Minimum necessary: no notes, no history. */
export async function linkDetails(link: LinkRow) {
  const clinic = link.clinic;
  const base = {
    clinic: { name: clinic.name, phone: formatUsPhone(clinic.aiPhoneNumber), phoneE164: clinic.aiPhoneNumber, address: clinic.address },
    firstName: link.patient.firstName,
  };
  if (!link.appointmentId) return { ...base, appointment: null };
  const appt = await db.query.appointments.findFirst({
    where: and(eq(schema.appointments.id, link.appointmentId), eq(schema.appointments.clinicId, clinic.id)),
    with: { provider: true, service: true },
  });
  if (!appt) return { ...base, appointment: null };
  const future = appt.startAt.getTime() > Date.now();
  return {
    ...base,
    appointment: {
      when: speakable(appt.startAt, clinic.timezone),
      service: appt.service?.name ?? null,
      provider: appt.provider?.name ?? null,
      status: appt.status,
      canConfirm: future && appt.status === "BOOKED",
      canReschedule: future && (appt.status === "BOOKED" || appt.status === "CONFIRMED"),
    },
  };
}
