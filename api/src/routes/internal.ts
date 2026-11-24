// Endpoints used only by the voice agent (authenticated with X-Internal-Key).
// Every tool call is tied to a call record, and the AI can only touch appointments that
// belong to the patient on that call (matched by phone number) — never anyone else's.
import { Router } from "express";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import { db, schema } from "../db";
import type { Patient } from "../db/schema";
import { audit } from "../lib/audit";
import { encrypt } from "../lib/crypto";
import { dobHash, MAX_VERIFY_ATTEMPTS, normalizeDob, sameName } from "../lib/identity";
import { ah, badRequest, HttpError, notFound } from "../lib/http";
import { normalizeUsPhone } from "../lib/phone";
import { speakable } from "../lib/time";
import { requireInternalKey } from "../middleware/auth";
import { addTask, createLead, logActivity, openLeadForPhone, setStage } from "../services/crm";
import { notifyClinic } from "../services/notify";
import { billingAllowsService, features } from "../services/plans";
import {
  bookAppointment, findNextSlots, getAvailability, getClinic, setAppointmentStatus, upsertPatient,
} from "../services/scheduling";

export const internalRouter = Router();
internalRouter.use(requireInternalKey);

const AGENT = "voice-agent";

async function upcomingFor(clinicId: string, patientId: string, tz: string) {
  const rows = await db.query.appointments.findMany({
    where: and(
      eq(schema.appointments.clinicId, clinicId),
      eq(schema.appointments.patientId, patientId),
      gte(schema.appointments.startAt, new Date()),
      inArray(schema.appointments.status, ["BOOKED", "CONFIRMED"]),
    ),
    with: { service: true, provider: true },
    orderBy: asc(schema.appointments.startAt),
    limit: 5,
  });
  return rows.map((a) => ({
    appointmentId: a.id, when: speakable(a.startAt, tz), startAt: a.startAt.toISOString(), status: a.status,
    service: a.service?.name ?? null, provider: a.provider?.name ?? null,
  }));
}

/** Called when a call connects. Returns everything the agent needs to build its prompt. */
internalRouter.post("/calls/start", ah(async (req, res) => {
  const b = z.object({
    direction: z.enum(["INBOUND", "OUTBOUND"]),
    from: z.string(),
    to: z.string(),
    plivoCallUuid: z.string().nullish(),
    taskId: z.string().nullish(),
  }).parse(req.body);

  let clinicId: string;
  let patient: Patient | null = null;
  let purpose: "RECEPTION" | "NO_SHOW_REBOOK" | "FEEDBACK" = "RECEPTION";
  let appointmentId: string | null = null;
  let missedAppointment: { when: string; service: string | null } | null = null;

  if (b.direction === "INBOUND") {
    const to = normalizeUsPhone(b.to);
    let clinic = to ? await db.query.clinics.findFirst({ where: eq(schema.clinics.aiPhoneNumber, to) }) : null;
    if (!clinic && to) {
      // Extra numbers (Pro plan)
      const extra = await db.query.clinicNumbers.findFirst({ where: eq(schema.clinicNumbers.number, to) });
      if (extra) clinic = await db.query.clinics.findFirst({ where: eq(schema.clinics.id, extra.clinicId) });
    }
    if (!clinic || !clinic.active || !clinic.aiEnabled || !billingAllowsService(clinic)) throw notFound("No active clinic for this number");
    clinicId = clinic.id;
    const from = normalizeUsPhone(b.from);
    if (from) {
      patient = (await db.query.patients.findFirst({
        where: and(eq(schema.patients.clinicId, clinicId), eq(schema.patients.phone, from)),
      })) ?? null;
    }
  } else {
    if (!b.taskId) throw badRequest("taskId required for outbound");
    const task = await db.query.outboundTasks.findFirst({
      where: eq(schema.outboundTasks.id, b.taskId),
      with: { patient: true, appointment: { with: { service: true } } },
    });
    if (!task) throw notFound("Task not found");
    clinicId = task.clinicId;
    patient = task.patient;
    purpose = task.purpose;
    appointmentId = task.appointmentId;
    const clinicTz = (await getClinic(clinicId)).timezone;
    if (task.appointment) missedAppointment = { when: speakable(task.appointment.startAt, clinicTz), service: task.appointment.service?.name ?? null };
  }

  const clinic = await getClinic(clinicId);
  const [call] = await db.insert(schema.calls).values({
    clinicId, patientId: patient?.id, appointmentId, taskId: b.taskId ?? null, plivoCallUuid: b.plivoCallUuid ?? null,
    direction: b.direction, purpose, fromNumber: b.from, toNumber: b.to,
  }).returning();
  const f = features(clinic);

  const services = await db.query.services.findMany({
    where: and(eq(schema.services.clinicId, clinicId), eq(schema.services.active, true)),
  });
  const providers = await db.query.providers.findMany({
    where: and(eq(schema.providers.clinicId, clinicId), eq(schema.providers.active, true)),
  });
  const now = DateTime.now().setZone(clinic.timezone);

  await audit(null, { action: "CALL_STARTED", entity: "call", entityId: call.id, clinicId, meta: { direction: b.direction, purpose } }, AGENT);

  res.json({
    callId: call.id,
    purpose,
    clinic: {
      name: clinic.name, timezone: clinic.timezone, address: clinic.address, website: clinic.website,
      businessHours: clinic.businessHours, greeting: clinic.aiGreeting, extraInstructions: clinic.aiExtraInstructions,
      transferNumber: clinic.transferNumber, smsEnabled: clinic.smsEnabled,
      // Phone line rules the agent must follow (AI + transcription disclosure, automated-call consent)
      collectInsurance: true,
      nowLocal: now.toFormat("cccc, LLLL d, yyyy h:mm a"), todayISO: now.toISODate(),
    },
    services: services.map((s) => ({ id: s.id, name: s.name, durationMin: s.durationMin, description: s.description })),
    providers: providers.map((p) => ({ id: p.id, name: p.name, title: p.title })),
    // Inbound: caller ID can be spoofed, so the agent only learns whether the number is known.
    // Details come from find_my_appointments after the caller gives their first name.
    // Outbound: we dialed a number on file; the agent confirms it is talking to this person first.
    patient: patient
      ? b.direction === "INBOUND"
        ? { known: true, isNew: patient.isNew, smsConsent: patient.smsConsent, hasDob: !!patient.dobHash }
        : { known: true, isNew: patient.isNew, smsConsent: patient.smsConsent, firstName: patient.firstName, hasDob: !!patient.dobHash }
      : null,
    missedAppointment,
    features: f,
  });
}));

/** The phone number whose appointments this call may manage. */
async function callContext(callId: string) {
  const call = await db.query.calls.findFirst({ where: eq(schema.calls.id, callId) });
  if (!call) throw notFound("Call not found");
  const clinic = await getClinic(call.clinicId);
  const phone =
    call.direction === "INBOUND" ? normalizeUsPhone(call.fromNumber) : normalizeUsPhone(call.toNumber);
  return { call, clinic, phone };
}

async function setOutcome(callId: string, outcome: string, appointmentId?: string) {
  await db.update(schema.calls).set({ outcome, ...(appointmentId ? { appointmentId } : {}) }).where(eq(schema.calls.id, callId));
}

async function ownedAppointment(
  call: { verifiedPatientId: string | null }, clinicId: string, phone: string | null, appointmentId: string,
) {
  if (!phone) throw new HttpError(403, "Caller ID unavailable — cannot change appointments");
  if (!call.verifiedPatientId) throw new HttpError(403, "Verify the caller with verify_caller first");
  const a = await db.query.appointments.findFirst({
    where: and(eq(schema.appointments.id, appointmentId), eq(schema.appointments.clinicId, clinicId)),
    with: { patient: true },
  });
  if (!a || a.patient.phone !== phone || a.patientId !== call.verifiedPatientId) {
    throw new HttpError(403, "That appointment is not on file for this caller");
  }
  return a;
}

/** Single entry point for all AI tool calls. */
internalRouter.post("/tools/:name", ah(async (req, res) => {
  const { callId, args } = z.object({ callId: z.string(), args: z.record(z.string(), z.any()).default({}) }).parse(req.body);
  const { call, clinic, phone } = await callContext(callId);
  const tz = clinic.timezone;
  const name = req.params.name;
  const log = (action: string, entityId?: string) =>
    audit(null, { action: `AI_${action}`, entity: "call", entityId: entityId ?? call.id, clinicId: clinic.id }, AGENT);

  switch (name) {
    case "check_availability": {
      const a = z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        partOfDay: z.enum(["morning", "afternoon", "evening", "any"]).optional(),
        serviceId: z.string().optional(),
        providerId: z.string().optional(),
      }).parse(args);
      let slots = a.date
        ? await getAvailability({ clinicId: clinic.id, date: a.date, serviceId: a.serviceId, providerId: a.providerId })
        : await findNextSlots({ clinicId: clinic.id, serviceId: a.serviceId, providerId: a.providerId, partOfDay: a.partOfDay, limit: 4 });
      if (a.date && a.partOfDay && a.partOfDay !== "any") {
        slots = slots.filter((s) => {
          const h = DateTime.fromISO(s.startAt).setZone(tz).hour;
          return a.partOfDay === "morning" ? h < 12 : a.partOfDay === "afternoon" ? h >= 12 && h < 17 : h >= 17;
        });
      }
      // Offer a short list — easier to say on the phone
      const pick = slots.length > 6 ? slots.filter((_, i) => i % Math.ceil(slots.length / 6) === 0).slice(0, 6) : slots;
      return res.json({ slots: pick.map((s) => ({ startAt: s.startAt, when: s.label, provider: s.providerName })), message: pick.length ? undefined : "No openings for that request." });
    }

    case "book_appointment": {
      const a = z.object({
        startAt: z.string(),
        firstName: z.string().min(1),
        lastName: z.string().optional(),
        serviceId: z.string().optional(),
        providerId: z.string().optional(),
        reason: z.string().max(200).optional(),
        smsConsent: z.boolean().optional(),
        callConsent: z.boolean().optional(),
        dateOfBirth: z.string().max(40).optional(),
        insurance: z.string().max(200).optional(),
        callbackPhone: z.string().optional(),
      }).parse(args);
      const bookPhone = phone ?? normalizeUsPhone(a.callbackPhone);
      // An unverified caller may book, but may not rename an existing patient record on this number.
      const onFile = bookPhone
        ? await db.query.patients.findFirst({ where: and(eq(schema.patients.clinicId, clinic.id), eq(schema.patients.phone, bookPhone)) })
        : null;
      const mayEdit = !onFile || call.verifiedPatientId === onFile.id;
      if (a.dateOfBirth && !normalizeDob(a.dateOfBirth)) {
        return res.json({ ok: false, error: "That date of birth didn't sound right. Ask again for month, day and year." });
      }
      if (!bookPhone) return res.json({ ok: false, error: "Need a phone number for the appointment. Ask the caller for their 10 digit number." });
      try {
        const appt = await bookAppointment({
          clinicId: clinic.id, patientPhone: bookPhone,
          firstName: mayEdit || !onFile?.firstName ? a.firstName : undefined,
          lastName: mayEdit || !onFile?.lastName ? a.lastName : undefined,
          startAt: a.startAt, serviceId: a.serviceId, providerId: a.providerId, reason: a.reason,
          smsConsent: mayEdit || !onFile ? a.smsConsent : undefined,
          // Only when the caller said yes to calls about their visit, including automated calls (TCPA)
          callConsent: a.callConsent === true && mayEdit ? true : undefined,
          dateOfBirth: a.dateOfBirth,
          insurance: mayEdit ? a.insurance : undefined,
          source: call.direction === "INBOUND" ? "AI_CALL" : "AI_OUTBOUND",
        });
        await db.update(schema.calls).set({ patientId: appt.patientId }).where(eq(schema.calls.id, call.id));
        await setOutcome(call.id, "BOOKED", appt.id);
        // CRM: move an open lead to "Appointment booked", or add new patients as a contact
        const when = speakable(appt.startAt, tz);
        const openLead = await openLeadForPhone(clinic.id, bookPhone);
        if (openLead) {
          if (["NEW", "CONTACTED"].includes(openLead.status)) await setStage(openLead, "APPT", "AI receptionist");
          await logActivity(openLead, "APPT", `AI booked an appointment for ${when}.`, "AI receptionist");
        } else {
          const p = await db.query.patients.findFirst({ where: eq(schema.patients.id, appt.patientId) });
          if (p?.isNew) {
            await createLead({
              clinicId: clinic.id, phone: bookPhone, patientId: p.id, name: [a.firstName, a.lastName].filter(Boolean).join(" "),
              interest: a.reason ?? "New patient visit", source: call.direction === "INBOUND" ? "AI call" : "AI outbound", stage: "APPT",
              tags: ["New patient"], actor: "AI receptionist", activity: { type: "APPT", text: `AI booked an appointment for ${when}.` },
            });
          }
        }
        await log("BOOKED", appt.id);
        return res.json({ ok: true, appointmentId: appt.id, when: speakable(appt.startAt, tz) });
      } catch (e) {
        if (e instanceof HttpError && e.status === 409) return res.json({ ok: false, error: "That time was just taken. Check availability again and offer other times." });
        throw e;
      }
    }

    case "verify_caller": {
      // Caller ID can be spoofed: before reading out or changing an existing appointment, the caller must
      // give the first name AND date of birth on file (or last name, for patients with no DOB on file yet).
      const a = z.object({
        firstName: z.string().min(1).max(60),
        lastName: z.string().max(60).optional(),
        dateOfBirth: z.string().max(40).optional(),
      }).parse(args);
      if (!phone) return res.json({ verified: false, message: "Caller ID unavailable. Offer to have the front desk call back." });
      if (call.verifiedPatientId) return res.json({ verified: true });
      if (call.verifyAttempts >= MAX_VERIFY_ATTEMPTS) {
        return res.json({ verified: false, locked: true, message: "Too many attempts. Do not share any details. Offer a callback from the front desk with save_inquiry." });
      }
      const p = await db.query.patients.findFirst({ where: and(eq(schema.patients.clinicId, clinic.id), eq(schema.patients.phone, phone)) });
      const [{ verifyAttempts }] = await db.update(schema.calls)
        .set({ verifyAttempts: sql`${schema.calls.verifyAttempts} + 1` })
        .where(eq(schema.calls.id, call.id)).returning({ verifyAttempts: schema.calls.verifyAttempts });
      const left = MAX_VERIFY_ATTEMPTS - verifyAttempts;
      const fail = async (needs?: string) => {
        await log("IDENTITY_MISMATCH");
        if (left <= 0) {
          await notifyClinic(clinic.id, "SECURITY", "Caller failed identity check", "A caller could not verify their identity 3 times. Review the call in the dashboard.", `/calls/${call.id}`);
          return res.json({ verified: false, locked: true, message: "Could not verify. Do not share any details. Offer a callback from the front desk." });
        }
        return res.json({ verified: false, attemptsLeft: left, message: needs ?? "Details don't match our records. Do not share any appointment details. You may ask them to repeat once." });
      };
      if (!p || !sameName(p.firstName, a.firstName)) return fail();
      if (p.dobHash) {
        const dob = normalizeDob(a.dateOfBirth);
        if (!dob) { // Not counted as a miss: they just haven't said it yet
          await db.update(schema.calls).set({ verifyAttempts: sql`${schema.calls.verifyAttempts} - 1` }).where(eq(schema.calls.id, call.id));
          return res.json({ verified: false, needs: "dateOfBirth", message: "Ask for their date of birth (month, day and year), then call verify_caller again." });
        }
        if (dobHash(dob) !== p.dobHash) return fail();
      } else {
        if (!p.lastName) {
          // Only a first name on file: weakest case. Allow, but staff can add a DOB in the dashboard.
        } else if (!a.lastName) {
          await db.update(schema.calls).set({ verifyAttempts: sql`${schema.calls.verifyAttempts} - 1` }).where(eq(schema.calls.id, call.id));
          return res.json({ verified: false, needs: "lastName", message: "Ask for their last name, then call verify_caller again." });
        } else if (!sameName(p.lastName, a.lastName)) return fail();
      }
      await db.update(schema.calls).set({ verifiedPatientId: p.id, verifiedAt: new Date(), patientId: p.id }).where(eq(schema.calls.id, call.id));
      await log("IDENTITY_VERIFIED");
      // Ask for a DOB next time if we don't have one yet
      return res.json({ verified: true, askDobForRecords: !p.dobHash });
    }

    case "find_my_appointments": {
      if (!phone) return res.json({ appointments: [], message: "Caller ID unavailable. Offer to have the front desk call back." });
      if (!call.verifiedPatientId) return res.json({ appointments: [], message: "Verify the caller first with verify_caller. Do not share any details yet." });
      return res.json({ appointments: await upcomingFor(clinic.id, call.verifiedPatientId, tz) });
    }

    case "save_date_of_birth": {
      // After a weak (name-only) verification, store a DOB so future calls use the stronger check.
      const a = z.object({ dateOfBirth: z.string().max(40) }).parse(args);
      if (!call.verifiedPatientId) return res.json({ ok: false, error: "Caller not verified." });
      const dob = normalizeDob(a.dateOfBirth);
      if (!dob) return res.json({ ok: false, error: "Ask again for month, day and year." });
      const p = await db.query.patients.findFirst({ where: eq(schema.patients.id, call.verifiedPatientId) });
      if (p && !p.dobHash) await db.update(schema.patients).set({ dobHash: dobHash(dob), dobEnc: encrypt(dob) }).where(eq(schema.patients.id, p.id));
      return res.json({ ok: true });
    }

    case "opt_out_calls": {
      // "Stop calling me" / "take me off your list" — honored immediately for automated calls (TCPA).
      const target = call.patientId ?? (phone
        ? (await db.query.patients.findFirst({ where: and(eq(schema.patients.clinicId, clinic.id), eq(schema.patients.phone, phone)) }))?.id
        : undefined);
      if (target) {
        await db.update(schema.patients).set({ callOptOut: true, callConsent: false }).where(eq(schema.patients.id, target));
        await db.update(schema.outboundTasks).set({ status: "CANCELLED", lastError: "patient opted out of calls" })
          .where(and(eq(schema.outboundTasks.patientId, target), eq(schema.outboundTasks.status, "PENDING"), eq(schema.outboundTasks.channel, "CALL")));
      }
      await log("CALL_OPT_OUT");
      return res.json({ ok: true });
    }

    case "reschedule_appointment": {
      const a = z.object({ appointmentId: z.string(), newStartAt: z.string() }).parse(args);
      const old = await ownedAppointment(call, clinic.id, phone, a.appointmentId);
      try {
        const appt = await bookAppointment({
          clinicId: clinic.id, patientPhone: old.patient.phone, startAt: a.newStartAt, serviceId: old.serviceId,
          providerId: old.providerId, reason: old.reason ?? undefined, rescheduledFromId: old.id,
          source: call.direction === "INBOUND" ? "AI_CALL" : "AI_OUTBOUND",
        });
        await setOutcome(call.id, "RESCHEDULED", appt.id);
        await log("RESCHEDULED", appt.id);
        return res.json({ ok: true, appointmentId: appt.id, when: speakable(appt.startAt, tz) });
      } catch (e) {
        if (e instanceof HttpError && e.status === 409) return res.json({ ok: false, error: "That time was just taken. Offer other times." });
        throw e;
      }
    }

    case "cancel_appointment": {
      const a = z.object({ appointmentId: z.string() }).parse(args);
      await ownedAppointment(call, clinic.id, phone, a.appointmentId);
      await setAppointmentStatus(clinic.id, a.appointmentId, "CANCELLED");
      await setOutcome(call.id, "CANCELLED", a.appointmentId);
      await notifyClinic(clinic.id, "CANCELLED", "Appointment cancelled", "A patient cancelled by phone. Open the app for details.", `/appointments/${a.appointmentId}`);
      await log("CANCELLED", a.appointmentId);
      return res.json({ ok: true });
    }

    case "confirm_appointment": {
      const a = z.object({ appointmentId: z.string() }).parse(args);
      await ownedAppointment(call, clinic.id, phone, a.appointmentId);
      await setAppointmentStatus(clinic.id, a.appointmentId, "CONFIRMED");
      await log("CONFIRMED", a.appointmentId);
      return res.json({ ok: true });
    }

    case "save_inquiry": {
      const a = z.object({ name: z.string().optional(), interest: z.string().min(2).max(300), callbackPhone: z.string().optional() }).parse(args);
      const leadPhone = normalizeUsPhone(a.callbackPhone) ?? phone;
      if (!leadPhone) return res.json({ ok: false, error: "Ask for a callback number first." });
      const patient = await upsertPatient(clinic.id, leadPhone, { firstName: a.name?.split(" ")[0], lastName: a.name?.split(" ").slice(1).join(" ") || undefined });
      const existing = await openLeadForPhone(clinic.id, leadPhone);
      let leadId: string;
      if (existing) {
        await logActivity(existing, "CALL", `AI call: ${a.interest}`, "AI receptionist");
        await addTask(existing, { title: `Call back: ${a.interest}`.slice(0, 120), dueInMinutes: 60 });
        leadId = existing.id;
      } else {
        const lead = await createLead({
          clinicId: clinic.id, patientId: patient.id, name: a.name, phone: leadPhone, interest: a.interest,
          source: call.direction === "INBOUND" ? "AI call" : "AI outbound", actor: "AI receptionist",
          activity: { type: "CALL", text: `AI call: ${a.interest}` },
          task: { title: `Call back: ${a.interest}`.slice(0, 120), dueInMinutes: 60 },
        });
        leadId = lead.id;
      }
      if (!call.outcome) await setOutcome(call.id, "LEAD");
      await notifyClinic(clinic.id, "NEW_LEAD", "New inquiry captured", "The AI receptionist captured a new inquiry. Open the CRM to follow up.", `/crm`);
      await log("LEAD", leadId);
      return res.json({ ok: true });
    }

    case "save_feedback": {
      const a = z.object({ rating: z.number().int().min(1).max(5).optional(), comment: z.string().max(2000).optional() }).parse(args);
      if (!call.patientId) throw badRequest("No patient on this call");
      await db.insert(schema.feedback).values({
        clinicId: clinic.id, patientId: call.patientId, appointmentId: call.appointmentId, rating: a.rating,
        commentEnc: encrypt(a.comment), channel: "CALL",
      });
      await setOutcome(call.id, "FEEDBACK");
      if (a.rating !== undefined && a.rating <= 3) {
        await notifyClinic(clinic.id, "FEEDBACK", "Low feedback score", `A patient rated their visit ${a.rating}/5. Open the app to see the comment.`, `/feedback`);
      }
      await log("FEEDBACK");
      return res.json({ ok: true });
    }

    case "transfer_requested": {
      const a = z.object({ reason: z.string().max(200).optional() }).parse(args);
      await setOutcome(call.id, "TRANSFERRED");
      await notifyClinic(clinic.id, "TRANSFER", "Call transferred to staff", "The AI is transferring a caller to your line now.");
      await log("TRANSFER");
      return res.json({ ok: true, transferNumber: clinic.transferNumber, reason: a.reason });
    }

    default:
      throw notFound(`Unknown tool ${name}`);
  }
}));

/** Call ended: store encrypted transcript + summary. */
internalRouter.post("/calls/:id/end", ah(async (req, res) => {
  const b = z.object({
    transcript: z.string().nullish(),
    summary: z.string().nullish(),
    outcome: z.string().nullish(),
    durationSec: z.number().int().nullish(),
  }).parse(req.body);
  const call = await db.query.calls.findFirst({ where: eq(schema.calls.id, req.params.id) });
  if (!call) throw notFound();
  await db.update(schema.calls).set({
    endedAt: new Date(),
    durationSec: b.durationSec ?? Math.round((Date.now() - call.startedAt.getTime()) / 1000),
    transcriptEnc: encrypt(b.transcript),
    summaryEnc: encrypt(b.summary),
    outcome: call.outcome ?? b.outcome ?? "INFO",
  }).where(eq(schema.calls.id, call.id));
  if (call.taskId) {
    await db.update(schema.outboundTasks).set({ status: "DONE" }).where(eq(schema.outboundTasks.id, call.taskId));
  }
  res.json({ ok: true });
}));

/** Outbound call couldn't connect (no answer / busy / failed). */
internalRouter.post("/tasks/:id/result", ah(async (req, res) => {
  const b = z.object({ status: z.enum(["NO_ANSWER", "FAILED", "DONE"]), error: z.string().nullish() }).parse(req.body);
  const task = await db.query.outboundTasks.findFirst({ where: eq(schema.outboundTasks.id, req.params.id) });
  if (!task) throw notFound();
  if (b.status === "DONE") {
    await db.update(schema.outboundTasks).set({ status: "DONE" }).where(eq(schema.outboundTasks.id, task.id));
  } else if (task.attempts >= task.maxAttempts) {
    await db.update(schema.outboundTasks).set({ status: "FAILED", lastError: b.error ?? b.status }).where(eq(schema.outboundTasks.id, task.id));
  } else {
    // Retry next day-ish (dispatcher moves it into calling hours)
    await db.update(schema.outboundTasks).set({
      status: "PENDING", lastError: b.error ?? b.status, nextAttemptAt: new Date(Date.now() + 20 * 3600_000),
    }).where(eq(schema.outboundTasks.id, task.id));
  }
  res.json({ ok: true });
}));
