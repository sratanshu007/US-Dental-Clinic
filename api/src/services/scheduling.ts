import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, schema } from "../db";
import type { Appointment, Clinic, Patient } from "../db/schema";
import { encrypt } from "../lib/crypto";
import { badRequest, HttpError, notFound } from "../lib/http";
import { dobHash, normalizeDob } from "../lib/identity";
import { nextCallingTime, openWindows, speakable } from "../lib/time";
import { notifyClinic } from "./notify";
import { sendSms } from "./sms";
import { bookedText } from "./smsText";
import { queuePmsPush } from "./pmsQueue";
import { features } from "./plans";

/** Statuses that occupy a slot on the calendar. */
export const ACTIVE_STATUSES = ["BOOKED", "CONFIRMED", "SHOWED"] as const;

export interface Slot {
  startAt: string; // ISO (UTC)
  endAt: string;
  label: string; // "Tuesday, March 3 at 2:30 PM" in clinic time
  providerId: string | null;
  providerName: string | null;
}

/** db or a transaction: queries inside a booking transaction must use the same connection (no pool deadlock). */
export type Q = Pick<typeof db, "query" | "insert" | "update" | "delete" | "select" | "execute">;

export async function getClinic(clinicId: string, q: Q = db): Promise<Clinic> {
  const c = await q.query.clinics.findFirst({ where: eq(schema.clinics.id, clinicId) });
  if (!c) throw notFound("Clinic not found");
  return c;
}

async function serviceDuration(clinic: Clinic, serviceId?: string | null, q: Q = db): Promise<number> {
  if (!serviceId) return clinic.slotMinutes;
  const s = await q.query.services.findFirst({
    where: and(eq(schema.services.id, serviceId), eq(schema.services.clinicId, clinic.id)),
  });
  if (!s) throw badRequest("Unknown service");
  return s.durationMin;
}

const overlaps = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) => aStart < bEnd && bStart < aEnd;

/** Free slots for one local date. With providers: a slot is free if any (or the chosen) provider is free. */
export async function getAvailability(opts: {
  clinicId: string;
  date: string; // YYYY-MM-DD in clinic time
  serviceId?: string | null;
  providerId?: string | null;
  excludeAppointmentId?: string;
}, q: Q = db): Promise<Slot[]> {
  const clinic = await getClinic(opts.clinicId, q);
  const tz = clinic.timezone;
  const duration = await serviceDuration(clinic, opts.serviceId, q);
  const windows = openWindows(clinic.businessHours, opts.date, tz);
  if (!windows.length) return [];

  const dayStart = DateTime.fromISO(opts.date, { zone: tz }).startOf("day");
  const dayEnd = dayStart.plus({ days: 1 });

  let providers = await q.query.providers.findMany({
    where: and(eq(schema.providers.clinicId, clinic.id), eq(schema.providers.active, true)),
  });
  if (opts.providerId) providers = providers.filter((p) => p.id === opts.providerId);
  if (opts.providerId && !providers.length) throw badRequest("Unknown provider");

  const booked = (
    await q.query.appointments.findMany({
      where: and(
        eq(schema.appointments.clinicId, clinic.id),
        inArray(schema.appointments.status, [...ACTIVE_STATUSES]),
        lt(schema.appointments.startAt, dayEnd.toJSDate()),
        gte(schema.appointments.endAt, dayStart.toJSDate()),
      ),
    })
  ).filter((a) => a.id !== opts.excludeAppointmentId)
    .map((a) => ({ id: a.id, providerId: a.providerId, startAt: a.startAt, endAt: a.endAt }));

  // Busy times from the clinic's practice software (Open Dental). A null provider blocks everyone.
  const pmsBusy = await q.query.pmsBusyBlocks.findMany({
    where: and(
      eq(schema.pmsBusyBlocks.clinicId, clinic.id),
      lt(schema.pmsBusyBlocks.startAt, dayEnd.toJSDate()),
      gte(schema.pmsBusyBlocks.endAt, dayStart.toJSDate()),
    ),
  });
  // Our own bookings that were pushed to the PMS come back as busy blocks; don't count them twice.
  const pushed = new Set((await q.query.appointments.findMany({
    where: and(eq(schema.appointments.clinicId, clinic.id), lt(schema.appointments.startAt, dayEnd.toJSDate()), gte(schema.appointments.endAt, dayStart.toJSDate())),
    columns: { pmsAptNum: true, id: true },
  })).filter((a) => a.pmsAptNum !== null && a.id !== opts.excludeAppointmentId).map((a) => a.pmsAptNum));
  const excludedAptNum = opts.excludeAppointmentId
    ? (await q.query.appointments.findFirst({ where: eq(schema.appointments.id, opts.excludeAppointmentId), columns: { pmsAptNum: true } }))?.pmsAptNum ?? null
    : null;
  for (const b of pmsBusy) {
    if (pushed.has(b.pmsAptNum) || b.pmsAptNum === excludedAptNum) continue;
    booked.push({ id: `pms:${b.pmsAptNum}`, providerId: b.providerId, startAt: b.startAt, endAt: b.endAt });
  }
  const clashes = (providerId: string | null, start: Date, end: Date) =>
    booked.some((a) => (a.providerId === null || providerId === null || a.providerId === providerId) && overlaps(start, end, a.startAt, a.endAt));

  const earliest = DateTime.now().plus({ minutes: 30 }); // don't offer slots starting in < 30 min
  const slots: Slot[] = [];

  for (const [wStart, wEnd] of windows) {
    for (let s = wStart; s.plus({ minutes: duration }) <= wEnd; s = s.plus({ minutes: clinic.slotMinutes })) {
      if (s < earliest) continue;
      const start = s.toJSDate();
      const end = s.plus({ minutes: duration }).toJSDate();

      if (providers.length === 0) {
        // No providers configured: one appointment at a time.
        if (!clashes(null, start, end)) {
          slots.push({ startAt: start.toISOString(), endAt: end.toISOString(), label: speakable(start, tz), providerId: null, providerName: null });
        }
        continue;
      }
      const free = providers.find(
        (p) => !booked.some((a) => (a.providerId === p.id || a.providerId === null) && overlaps(start, end, a.startAt, a.endAt)),
      );
      if (free) {
        slots.push({ startAt: start.toISOString(), endAt: end.toISOString(), label: speakable(start, tz), providerId: free.id, providerName: free.name });
      }
    }
  }
  return slots;
}

/** First few free slots from a date onward — what the AI offers callers. */
export async function findNextSlots(opts: {
  clinicId: string;
  fromDate?: string;
  days?: number;
  serviceId?: string | null;
  providerId?: string | null;
  partOfDay?: "morning" | "afternoon" | "evening" | "any";
  limit?: number;
  excludeAppointmentId?: string;
}): Promise<Slot[]> {
  const clinic = await getClinic(opts.clinicId);
  const tz = clinic.timezone;
  const limit = opts.limit ?? 3;
  let day = opts.fromDate ? DateTime.fromISO(opts.fromDate, { zone: tz }) : DateTime.now().setZone(tz);
  const out: Slot[] = [];
  for (let i = 0; i < (opts.days ?? 14) && out.length < limit; i++, day = day.plus({ days: 1 })) {
    const slots = await getAvailability({ ...opts, date: day.toISODate()! });
    for (const s of slots) {
      const hour = DateTime.fromISO(s.startAt).setZone(tz).hour;
      const pod = opts.partOfDay ?? "any";
      if (pod === "morning" && hour >= 12) continue;
      if (pod === "afternoon" && (hour < 12 || hour >= 17)) continue;
      if (pod === "evening" && hour < 17) continue;
      out.push(s);
      // Spread suggestions: at most 2 per day
      if (out.filter((o) => o.startAt.slice(0, 10) === s.startAt.slice(0, 10)).length >= 2) break;
      if (out.length >= limit) break;
    }
  }
  return out;
}

export async function upsertPatient(
  clinicId: string,
  phone: string,
  data: Partial<Pick<Patient, "firstName" | "lastName" | "email" | "smsConsent" | "callConsent">> & {
    dateOfBirth?: string;
    insurance?: string;
    consentSource?: string;
  } = {},
  q: Q = db,
): Promise<Patient> {
  const existing = await q.query.patients.findFirst({
    where: and(eq(schema.patients.clinicId, clinicId), eq(schema.patients.phone, phone)),
  });
  const { dateOfBirth, insurance, consentSource, ...plain } = data;
  const extra: Partial<Patient> = {};
  const dob = normalizeDob(dateOfBirth);
  // Never overwrite a DOB already on file from a phone call (that would let a caller re-key the identity check)
  if (dob && !existing?.dobHash) { extra.dobHash = dobHash(dob); extra.dobEnc = encrypt(dob); }
  if (insurance) extra.insuranceEnc = encrypt(insurance.slice(0, 200));
  if (plain.callConsent === true) {
    extra.callConsentAt = new Date();
    extra.callConsentSource = consentSource ?? "STAFF";
    extra.callOptOut = false;
  }
  const clean = { ...Object.fromEntries(Object.entries(plain).filter(([, v]) => v !== undefined && v !== null && v !== "")), ...extra };
  if (existing) {
    if (Object.keys(clean).length) {
      const [p] = await q.update(schema.patients).set(clean).where(eq(schema.patients.id, existing.id)).returning();
      return p;
    }
    return existing;
  }
  const [p] = await q.insert(schema.patients).values({ clinicId, phone, ...clean }).returning();
  return p;
}

export interface BookInput {
  clinicId: string;
  patientPhone: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  startAt: string; // ISO
  serviceId?: string | null;
  providerId?: string | null;
  reason?: string;
  source: "AI_CALL" | "AI_OUTBOUND" | "SMS" | "STAFF";
  smsConsent?: boolean;
  callConsent?: boolean;
  dateOfBirth?: string;
  insurance?: string;
  rescheduledFromId?: string;
}

/** Book a slot. Serialized per clinic with an advisory lock so two callers can't take the same slot. */
export async function bookAppointment(input: BookInput): Promise<Appointment> {
  const clinic = await getClinic(input.clinicId);
  const start = DateTime.fromISO(input.startAt);
  if (!start.isValid) throw badRequest("Invalid startAt");
  const localDate = start.setZone(clinic.timezone).toISODate()!;

  const appt = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${clinic.id}))`);
    const free = await getAvailability({
      clinicId: clinic.id,
      date: localDate,
      serviceId: input.serviceId,
      providerId: input.providerId,
      excludeAppointmentId: input.rescheduledFromId,
    }, tx);
    const slot = free.find((s) => Date.parse(s.startAt) === start.toMillis());
    if (!slot) throw new HttpError(409, "That time is no longer available");

    const patient = await upsertPatient(clinic.id, input.patientPhone, {
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      smsConsent: input.smsConsent,
      callConsent: input.callConsent,
      dateOfBirth: input.dateOfBirth,
      insurance: input.insurance,
      consentSource: input.source,
    }, tx);

    if (input.rescheduledFromId) {
      await tx
        .update(schema.appointments)
        .set({ status: "RESCHEDULED", statusChangedAt: new Date() })
        .where(and(eq(schema.appointments.id, input.rescheduledFromId), eq(schema.appointments.clinicId, clinic.id)));
      await cancelOpenTasks(input.rescheduledFromId, tx);
    }

    const [created] = await tx
      .insert(schema.appointments)
      .values({
        clinicId: clinic.id,
        patientId: patient.id,
        providerId: slot.providerId,
        serviceId: input.serviceId ?? null,
        startAt: new Date(slot.startAt),
        endAt: new Date(slot.endAt),
        source: input.source,
        reason: input.reason?.slice(0, 200),
        rescheduledFromId: input.rescheduledFromId,
      })
      .returning();
    return { created, patient };
  });

  const when = speakable(appt.created.startAt, clinic.timezone);
  if (input.source !== "STAFF") {
    await notifyClinic(
      clinic.id,
      "NEW_BOOKING",
      input.rescheduledFromId ? "Appointment rescheduled" : "New appointment booked",
      `${input.rescheduledFromId ? "Rescheduled" : "Booked"} by AI for ${when}. Open the app for details.`,
      `/appointments/${appt.created.id}`,
    );
  }
  await sendSms(clinic, appt.patient, await bookedText(clinic, appt.patient, appt.created), "BOOKED", { skipConsentCheck: true });
  queuePmsPush(clinic, appt.created.id, input.rescheduledFromId);
  return appt.created;
}

export async function cancelOpenTasks(appointmentId: string, tx: Pick<typeof db, "update"> = db) {
  await tx
    .update(schema.outboundTasks)
    .set({ status: "CANCELLED" })
    .where(and(eq(schema.outboundTasks.appointmentId, appointmentId), inArray(schema.outboundTasks.status, ["PENDING"])));
}

/** Staff (or the auto no-show job) marks what happened. Triggers follow-ups. */
export async function setAppointmentStatus(
  clinicId: string,
  appointmentId: string,
  status: "BOOKED" | "CONFIRMED" | "SHOWED" | "NO_SHOW" | "CANCELLED",
): Promise<Appointment> {
  const clinic = await getClinic(clinicId);
  const existing = await db.query.appointments.findFirst({
    where: and(eq(schema.appointments.id, appointmentId), eq(schema.appointments.clinicId, clinicId)),
  });
  if (!existing) throw notFound("Appointment not found");

  const [appt] = await db
    .update(schema.appointments)
    .set({ status, statusChangedAt: new Date(), confirmedAt: status === "CONFIRMED" ? new Date() : existing.confirmedAt })
    .where(eq(schema.appointments.id, appointmentId))
    .returning();

  await cancelOpenTasks(appointmentId);
  if (status === "CANCELLED") queuePmsPush(clinic, appointmentId);
  const now = DateTime.now().setZone(clinic.timezone);
  const f = features(clinic);

  if (status === "NO_SHOW" && clinic.noShowFollowUp && f.noShowCalls) {
    const at = nextCallingTime(now.plus({ minutes: clinic.noShowDelayMinutes }), clinic.callingHoursStart, clinic.callingHoursEnd);
    await db.insert(schema.outboundTasks).values({
      clinicId, patientId: appt.patientId, appointmentId, purpose: "NO_SHOW_REBOOK", channel: "CALL", nextAttemptAt: at.toJSDate(),
    });
  }
  if (status === "SHOWED") {
    await db.update(schema.patients).set({ isNew: false }).where(eq(schema.patients.id, appt.patientId));
    if (clinic.feedbackEnabled && f.feedback) {
      const at = nextCallingTime(now.plus({ minutes: clinic.feedbackDelayMinutes }), clinic.callingHoursStart, clinic.callingHoursEnd);
      await db.insert(schema.outboundTasks).values({
        clinicId, patientId: appt.patientId, appointmentId, purpose: "FEEDBACK", channel: clinic.feedbackChannel, nextAttemptAt: at.toJSDate(),
      });
    }
  }
  return appt;
}
