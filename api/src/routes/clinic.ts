// Routes used by the clinic web dashboard and the mobile app.
import bcrypt from "bcryptjs";
import { Router } from "express";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import { db, schema } from "../db";
import { audit } from "../lib/audit";
import { decrypt, encrypt } from "../lib/crypto";
import { ah, badRequest, notFound } from "../lib/http";
import { normalizeUsPhone } from "../lib/phone";
import { clinicScope, requireAuth, requireRole } from "../middleware/auth";
import { dailySummary, rangeSummary } from "../services/reports";
import {
  bookAppointment, findNextSlots, getAvailability, getClinic, setAppointmentStatus, upsertPatient,
} from "../services/scheduling";
import { publicUser } from "./auth";

export const clinicRouter = Router();
clinicRouter.use(requireAuth);

const ownerOnly = requireRole("CLINIC_OWNER", "SUPER_ADMIN");
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hhmm = z.string().regex(/^\d{2}:\d{2}$/);

const patientView = (p: typeof schema.patients.$inferSelect) => ({
  id: p.id, phone: p.phone, firstName: p.firstName, lastName: p.lastName, email: p.email, isNew: p.isNew,
  smsConsent: p.smsConsent, callConsent: p.callConsent, smsOptOut: p.smsOptOut, createdAt: p.createdAt,
});

// ---------------- Dashboard ----------------

clinicRouter.get("/dashboard", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const clinic = await getClinic(clinicId);
  const today = await dailySummary(clinicId);
  const now = new Date();
  const upcoming = await db.query.appointments.findMany({
    where: and(
      eq(schema.appointments.clinicId, clinicId),
      gte(schema.appointments.startAt, now),
      inArray(schema.appointments.status, ["BOOKED", "CONFIRMED"]),
    ),
    with: { patient: true, provider: true, service: true },
    orderBy: asc(schema.appointments.startAt),
    limit: 8,
  });
  const [{ n: openLeads }] = await db
    .select({ n: count() })
    .from(schema.leads)
    .where(and(eq(schema.leads.clinicId, clinicId), eq(schema.leads.status, "NEW")));
  const last7 = await rangeSummary(
    clinicId,
    DateTime.now().setZone(clinic.timezone).minus({ days: 6 }).toISODate()!,
    DateTime.now().setZone(clinic.timezone).toISODate()!,
  );
  const [crm] = await db.select({
    pipeline: sql<number>`coalesce(sum(${schema.leads.value}) filter (where ${schema.leads.status} not in ('WON','LOST')),0)::int`,
  }).from(schema.leads).where(eq(schema.leads.clinicId, clinicId));
  const [tasks] = await db.select({
    due: sql<number>`count(*) filter (where ${schema.crmTasks.dueAt} <= ${DateTime.now().setZone(clinic.timezone).endOf("day").toJSDate()})::int`,
    overdue: sql<number>`count(*) filter (where ${schema.crmTasks.dueAt} < ${new Date()})::int`,
  }).from(schema.crmTasks).where(and(eq(schema.crmTasks.clinicId, clinicId), isNull(schema.crmTasks.doneAt)));
  res.json({
    clinic: { id: clinic.id, name: clinic.name, timezone: clinic.timezone }, today, upcoming: upcoming.map(apptView), openLeads: Number(openLeads), last7,
    crm: { openPipeline: crm.pipeline, tasksDue: tasks.due, tasksOverdue: tasks.overdue },
  });
}));

// ---------------- Appointments ----------------

const apptView = (a: any) => ({
  id: a.id, startAt: a.startAt, endAt: a.endAt, status: a.status, source: a.source, reason: a.reason,
  confirmedAt: a.confirmedAt, reminderSentAt: a.reminderSentAt,
  patient: a.patient ? patientView(a.patient) : undefined,
  provider: a.provider ? { id: a.provider.id, name: a.provider.name } : null,
  service: a.service ? { id: a.service.id, name: a.service.name } : null,
});

clinicRouter.get("/appointments", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const clinic = await getClinic(clinicId);
  const q = z.object({
    from: dateStr.optional(), to: dateStr.optional(), status: z.string().optional(), providerId: z.string().optional(),
    source: z.enum(["AI", "STAFF"]).optional(), q: z.string().optional(),
  }).parse(req.query);
  const from = DateTime.fromISO(q.from ?? DateTime.now().setZone(clinic.timezone).toISODate()!, { zone: clinic.timezone }).startOf("day");
  const to = DateTime.fromISO(q.to ?? from.toISODate()!, { zone: clinic.timezone }).endOf("day");
  // status=OPEN means "waiting / not marked yet"
  const statuses = q.status?.split(",").flatMap((s) => (s === "OPEN" ? ["BOOKED", "CONFIRMED"] : [s])).filter(Boolean) as any[] | undefined;
  let rows = await db.query.appointments.findMany({
    where: and(
      eq(schema.appointments.clinicId, clinicId),
      gte(schema.appointments.startAt, from.toJSDate()),
      lt(schema.appointments.startAt, to.toJSDate()),
      statuses?.length ? inArray(schema.appointments.status, statuses) : undefined,
      q.providerId ? eq(schema.appointments.providerId, q.providerId) : undefined,
      q.source === "STAFF" ? eq(schema.appointments.source, "STAFF") : q.source === "AI" ? inArray(schema.appointments.source, ["AI_CALL", "AI_OUTBOUND", "SMS"]) : undefined,
    ),
    with: { patient: true, provider: true, service: true },
    orderBy: asc(schema.appointments.startAt),
  });
  const term = q.q?.trim().toLowerCase();
  if (term) {
    const digits = term.replace(/\D/g, "");
    rows = rows.filter((a) =>
      [a.patient.firstName, a.patient.lastName, a.service?.name, a.reason].filter(Boolean).join(" ").toLowerCase().includes(term) ||
      (digits.length >= 3 && a.patient.phone.includes(digits)));
  }
  await audit(req, { action: "LIST_APPOINTMENTS", clinicId, meta: { from: from.toISODate(), to: to.toISODate(), count: rows.length } });
  res.json(rows.map(apptView));
}));

clinicRouter.get("/appointments/:id", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const a = await db.query.appointments.findFirst({
    where: and(eq(schema.appointments.id, req.params.id), eq(schema.appointments.clinicId, clinicId)),
    with: { patient: true, provider: true, service: true },
  });
  if (!a) throw notFound();
  await audit(req, { action: "VIEW_APPOINTMENT", entity: "appointment", entityId: a.id, clinicId });
  res.json(apptView(a));
}));

clinicRouter.get("/availability", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const q = z.object({ date: dateStr, serviceId: z.string().optional(), providerId: z.string().optional() }).parse(req.query);
  res.json(await getAvailability({ clinicId, ...q }));
}));

clinicRouter.post("/appointments", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const b = z.object({
    phone: z.string(), firstName: z.string().optional(), lastName: z.string().optional(), email: z.string().email().optional(),
    startAt: z.string(), serviceId: z.string().optional(), providerId: z.string().optional(), reason: z.string().max(200).optional(),
    smsConsent: z.boolean().optional(), callConsent: z.boolean().optional(),
  }).parse(req.body);
  const phone = normalizeUsPhone(b.phone);
  if (!phone) throw badRequest("Invalid phone number");
  const appt = await bookAppointment({ ...b, clinicId, patientPhone: phone, source: "STAFF" });
  await audit(req, { action: "CREATE_APPOINTMENT", entity: "appointment", entityId: appt.id, clinicId });
  res.status(201).json(appt);
}));

clinicRouter.post("/appointments/:id/reschedule", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const { startAt } = z.object({ startAt: z.string() }).parse(req.body);
  const old = await db.query.appointments.findFirst({
    where: and(eq(schema.appointments.id, req.params.id), eq(schema.appointments.clinicId, clinicId)),
    with: { patient: true },
  });
  if (!old) throw notFound();
  const appt = await bookAppointment({
    clinicId, patientPhone: old.patient.phone, startAt, serviceId: old.serviceId, providerId: old.providerId,
    reason: old.reason ?? undefined, source: "STAFF", rescheduledFromId: old.id,
  });
  await audit(req, { action: "RESCHEDULE_APPOINTMENT", entity: "appointment", entityId: appt.id, clinicId, meta: { from: old.id } });
  res.json(appt);
}));

clinicRouter.patch("/appointments/:id/status", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const { status } = z.object({ status: z.enum(["BOOKED", "CONFIRMED", "SHOWED", "NO_SHOW", "CANCELLED"]) }).parse(req.body);
  const appt = await setAppointmentStatus(clinicId, req.params.id, status);
  await audit(req, { action: "SET_APPOINTMENT_STATUS", entity: "appointment", entityId: appt.id, clinicId, meta: { status } });
  res.json(appt);
}));

// ---------------- Patients ----------------

clinicRouter.get("/patients", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const { q, type, consent, upcoming } = z.object({
    q: z.string().optional(), type: z.enum(["new", "existing"]).optional(),
    consent: z.enum(["all", "nosms", "nocall", "optout"]).optional(), upcoming: z.enum(["yes", "no"]).optional(),
  }).parse(req.query);
  const term = q?.trim();
  const P = schema.patients;
  const upcomingSql = sql`exists (select 1 from appointments a where a.patient_id = ${P.id} and a.start_at > now() and a.status in ('BOOKED','CONFIRMED'))`;
  const rows = await db.query.patients.findMany({
    where: and(
      eq(schema.patients.clinicId, clinicId),
      type === "new" ? eq(P.isNew, true) : type === "existing" ? eq(P.isNew, false) : undefined,
      consent === "all" ? and(eq(P.smsConsent, true), eq(P.callConsent, true)) : consent === "nosms" ? eq(P.smsConsent, false)
        : consent === "nocall" ? eq(P.callConsent, false) : consent === "optout" ? eq(P.smsOptOut, true) : undefined,
      upcoming === "yes" ? upcomingSql : upcoming === "no" ? sql`not ${upcomingSql}` : undefined,
      term
        ? or(
            ilike(schema.patients.firstName, `%${term}%`),
            ilike(schema.patients.lastName, `%${term}%`),
            ilike(schema.patients.phone, `%${term.replace(/\D/g, "") || term}%`),
          )
        : undefined,
    ),
    orderBy: desc(schema.patients.createdAt),
    limit: 200,
  });
  const ids = rows.map((p) => p.id);
  const next = ids.length
    ? await db.query.appointments.findMany({
        where: and(inArray(schema.appointments.patientId, ids), gte(schema.appointments.startAt, new Date()), inArray(schema.appointments.status, ["BOOKED", "CONFIRMED"])),
        orderBy: asc(schema.appointments.startAt),
      })
    : [];
  await audit(req, { action: "LIST_PATIENTS", clinicId, meta: { count: rows.length, searched: !!term } });
  res.json(rows.map((p) => ({ ...patientView(p), nextAppointmentAt: next.find((a) => a.patientId === p.id)?.startAt ?? null })));
}));

clinicRouter.get("/patients/:id", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const p = await db.query.patients.findFirst({
    where: and(eq(schema.patients.id, req.params.id), eq(schema.patients.clinicId, clinicId)),
    with: {
      appointments: { with: { provider: true, service: true }, orderBy: desc(schema.appointments.startAt), limit: 50 },
      feedback: { orderBy: desc(schema.feedback.createdAt), limit: 20 },
      calls: { orderBy: desc(schema.calls.startedAt), limit: 20 },
    },
  });
  if (!p) throw notFound();
  await audit(req, { action: "VIEW_PATIENT", entity: "patient", entityId: p.id, clinicId });
  res.json({
    ...patientView(p),
    notes: decrypt(p.notesEnc),
    appointments: p.appointments.map(apptView),
    feedback: p.feedback.map((f) => ({ id: f.id, rating: f.rating, comment: decrypt(f.commentEnc), channel: f.channel, createdAt: f.createdAt })),
    calls: p.calls.map((c) => ({ id: c.id, direction: c.direction, purpose: c.purpose, outcome: c.outcome, startedAt: c.startedAt, durationSec: c.durationSec })),
  });
}));

clinicRouter.patch("/patients/:id", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const b = z.object({
    firstName: z.string().optional(), lastName: z.string().optional(), email: z.string().email().nullable().optional(),
    smsConsent: z.boolean().optional(), callConsent: z.boolean().optional(), smsOptOut: z.boolean().optional(), notes: z.string().nullable().optional(),
  }).parse(req.body);
  const { notes, ...rest } = b;
  const [p] = await db
    .update(schema.patients)
    .set({ ...rest, ...(notes !== undefined ? { notesEnc: encrypt(notes) } : {}) })
    .where(and(eq(schema.patients.id, req.params.id), eq(schema.patients.clinicId, clinicId)))
    .returning();
  if (!p) throw notFound();
  await audit(req, { action: "UPDATE_PATIENT", entity: "patient", entityId: p.id, clinicId, meta: { fields: Object.keys(b) } });
  res.json(patientView(p));
}));

clinicRouter.post("/patients", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const b = z.object({
    phone: z.string(), firstName: z.string().optional(), lastName: z.string().optional(), email: z.string().email().optional(),
    smsConsent: z.boolean().optional(), callConsent: z.boolean().optional(),
  }).parse(req.body);
  const phone = normalizeUsPhone(b.phone);
  if (!phone) throw badRequest("Invalid phone number");
  const p = await upsertPatient(clinicId, phone, b);
  await audit(req, { action: "CREATE_PATIENT", entity: "patient", entityId: p.id, clinicId });
  res.status(201).json(patientView(p));
}));

// ---------------- Calls ----------------

clinicRouter.get("/calls", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const f = z.object({
    direction: z.enum(["INBOUND", "OUTBOUND"]).optional(), purpose: z.enum(["RECEPTION", "NO_SHOW_REBOOK", "FEEDBACK"]).optional(),
    outcome: z.string().optional(), from: dateStr.optional(), to: dateStr.optional(), q: z.string().optional(),
  }).parse(req.query);
  const clinic = await getClinic(clinicId);
  const C = schema.calls;
  let rows = await db.query.calls.findMany({
    where: and(
      eq(C.clinicId, clinicId),
      f.direction ? eq(C.direction, f.direction) : undefined,
      f.purpose ? eq(C.purpose, f.purpose) : undefined,
      f.outcome ? eq(C.outcome, f.outcome) : undefined,
      f.from ? gte(C.startedAt, DateTime.fromISO(f.from, { zone: clinic.timezone }).startOf("day").toJSDate()) : undefined,
      f.to ? lt(C.startedAt, DateTime.fromISO(f.to, { zone: clinic.timezone }).endOf("day").toJSDate()) : undefined,
    ),
    with: { patient: true },
    orderBy: desc(C.startedAt),
    limit: 500,
  });
  const term = f.q?.trim().toLowerCase();
  if (term) {
    const digits = term.replace(/\D/g, "");
    rows = rows.filter((c) => [c.patient?.firstName, c.patient?.lastName].filter(Boolean).join(" ").toLowerCase().includes(term) ||
      (digits.length >= 3 && (c.fromNumber.includes(digits) || c.toNumber.includes(digits))));
  }
  res.json(rows.map((c) => ({
    id: c.id, direction: c.direction, purpose: c.purpose, fromNumber: c.fromNumber, toNumber: c.toNumber, startedAt: c.startedAt,
    durationSec: c.durationSec, outcome: c.outcome,
    patient: c.patient ? { id: c.patient.id, firstName: c.patient.firstName, lastName: c.patient.lastName } : null,
  })));
}));

clinicRouter.get("/calls/:id", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const c = await db.query.calls.findFirst({
    where: and(eq(schema.calls.id, req.params.id), eq(schema.calls.clinicId, clinicId)),
    with: { patient: true },
  });
  if (!c) throw notFound();
  await audit(req, { action: "VIEW_CALL", entity: "call", entityId: c.id, clinicId });
  res.json({
    id: c.id, direction: c.direction, purpose: c.purpose, fromNumber: c.fromNumber, toNumber: c.toNumber, startedAt: c.startedAt,
    endedAt: c.endedAt, durationSec: c.durationSec, outcome: c.outcome, appointmentId: c.appointmentId,
    summary: decrypt(c.summaryEnc), transcript: decrypt(c.transcriptEnc),
    patient: c.patient ? patientView(c.patient) : null,
  });
}));

// ---------------- Feedback ----------------

clinicRouter.get("/feedback", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const f = z.object({ rating: z.enum(["low", "high"]).optional(), channel: z.enum(["CALL", "SMS"]).optional(), q: z.string().optional() }).parse(req.query);
  const FB = schema.feedback;
  let rows = await db.query.feedback.findMany({
    where: and(
      eq(FB.clinicId, clinicId),
      f.rating === "low" ? lte(FB.rating, 3) : f.rating === "high" ? gte(FB.rating, 4) : undefined,
      f.channel ? eq(FB.channel, f.channel) : undefined,
    ),
    with: { patient: true },
    orderBy: desc(FB.createdAt),
    limit: 500,
  });
  const term = f.q?.trim().toLowerCase();
  if (term) rows = rows.filter((x) => `${x.patient.firstName ?? ""} ${x.patient.lastName ?? ""} ${decrypt(x.commentEnc) ?? ""}`.toLowerCase().includes(term));
  await audit(req, { action: "LIST_FEEDBACK", clinicId, meta: { count: rows.length } });
  res.json(rows.map((f) => ({
    id: f.id, rating: f.rating, comment: decrypt(f.commentEnc), channel: f.channel, createdAt: f.createdAt, appointmentId: f.appointmentId,
    patient: { id: f.patient.id, firstName: f.patient.firstName, lastName: f.patient.lastName },
  })));
}));

// ---------------- Reports ----------------

clinicRouter.get("/reports/daily", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const { date } = z.object({ date: dateStr.optional() }).parse(req.query);
  const summary = await dailySummary(clinicId, date);
  const clinic = await getClinic(clinicId);
  const day = DateTime.fromISO(summary.date!, { zone: clinic.timezone });
  const rows = await db.query.appointments.findMany({
    where: and(
      eq(schema.appointments.clinicId, clinicId),
      gte(schema.appointments.startAt, day.startOf("day").toJSDate()),
      lt(schema.appointments.startAt, day.endOf("day").toJSDate()),
    ),
    with: { patient: true, provider: true, service: true },
    orderBy: asc(schema.appointments.startAt),
  });
  await audit(req, { action: "VIEW_DAILY_REPORT", clinicId, meta: { date: summary.date } });
  res.json({ summary, appointments: rows.map(apptView) });
}));

clinicRouter.get("/reports/range", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const { from, to } = z.object({ from: dateStr, to: dateStr }).parse(req.query);
  res.json(await rangeSummary(clinicId, from, to));
}));

// ---------------- Notifications ----------------

clinicRouter.get("/notifications", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const f = z.object({ type: z.string().optional(), unread: z.enum(["1"]).optional() }).parse(req.query);
  const rows = await db.query.notifications.findMany({
    where: and(
      eq(schema.notifications.clinicId, clinicId),
      f.type ? eq(schema.notifications.type, f.type) : undefined,
      f.unread ? isNull(schema.notifications.readAt) : undefined,
    ),
    orderBy: desc(schema.notifications.createdAt),
    limit: 200,
  });
  res.json(rows);
}));

clinicRouter.post("/notifications/read-all", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  await db.update(schema.notifications).set({ readAt: new Date() })
    .where(and(eq(schema.notifications.clinicId, clinicId), isNull(schema.notifications.readAt)));
  res.json({ ok: true });
}));

// ---------------- Settings (owner) ----------------

clinicRouter.get("/settings", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const clinic = await getClinic(clinicId);
  const providers = await db.query.providers.findMany({ where: eq(schema.providers.clinicId, clinicId), orderBy: asc(schema.providers.name) });
  const services = await db.query.services.findMany({ where: eq(schema.services.clinicId, clinicId), orderBy: asc(schema.services.name) });
  res.json({ clinic, providers, services });
}));

const hoursSchema = z.record(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]), z.array(z.tuple([hhmm, hhmm])));

clinicRouter.patch("/settings", ownerOnly, ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const b = z.object({
    name: z.string().min(2).optional(),
    transferNumber: z.string().nullable().optional(),
    timezone: z.string().optional(),
    address: z.string().nullable().optional(),
    website: z.string().nullable().optional(),
    businessHours: hoursSchema.optional(),
    slotMinutes: z.number().int().min(5).max(120).optional(),
    aiEnabled: z.boolean().optional(),
    aiGreeting: z.string().max(500).nullable().optional(),
    aiExtraInstructions: z.string().max(4000).nullable().optional(),
    smsEnabled: z.boolean().optional(),
    reminderHoursBefore: z.number().int().min(1).max(168).optional(),
    noShowFollowUp: z.boolean().optional(),
    noShowDelayMinutes: z.number().int().min(0).max(4320).optional(),
    autoNoShowAfterMinutes: z.number().int().min(15).max(1440).nullable().optional(),
    feedbackEnabled: z.boolean().optional(),
    feedbackChannel: z.enum(["CALL", "SMS"]).optional(),
    feedbackDelayMinutes: z.number().int().min(0).max(4320).optional(),
    callingHoursStart: hhmm.optional(),
    callingHoursEnd: hhmm.optional(),
    dailyReportTime: hhmm.optional(),
    taskDigestTime: hhmm.optional(),
    retentionDays: z.number().int().min(7).max(3650).optional(),
  }).parse(req.body);
  if (b.transferNumber) {
    const t = normalizeUsPhone(b.transferNumber);
    if (!t) throw badRequest("Invalid transfer number");
    b.transferNumber = t;
  }
  if (b.timezone && !DateTime.now().setZone(b.timezone).isValid) throw badRequest("Invalid timezone");
  const [clinic] = await db.update(schema.clinics).set(b as any).where(eq(schema.clinics.id, clinicId)).returning();
  await audit(req, { action: "UPDATE_SETTINGS", clinicId, meta: { fields: Object.keys(b) } });
  res.json(clinic);
}));

clinicRouter.post("/providers", ownerOnly, ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const b = z.object({ name: z.string().min(1), title: z.string().optional() }).parse(req.body);
  const [p] = await db.insert(schema.providers).values({ clinicId, ...b }).returning();
  res.status(201).json(p);
}));

clinicRouter.patch("/providers/:id", ownerOnly, ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const b = z.object({ name: z.string().optional(), title: z.string().nullable().optional(), active: z.boolean().optional() }).parse(req.body);
  const [p] = await db.update(schema.providers).set(b)
    .where(and(eq(schema.providers.id, req.params.id), eq(schema.providers.clinicId, clinicId))).returning();
  if (!p) throw notFound();
  res.json(p);
}));

clinicRouter.post("/services", ownerOnly, ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const b = z.object({ name: z.string().min(1), durationMin: z.number().int().min(5).max(480), description: z.string().optional() }).parse(req.body);
  const [s] = await db.insert(schema.services).values({ clinicId, ...b }).returning();
  res.status(201).json(s);
}));

clinicRouter.patch("/services/:id", ownerOnly, ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const b = z.object({
    name: z.string().optional(), durationMin: z.number().int().min(5).max(480).optional(),
    description: z.string().nullable().optional(), active: z.boolean().optional(),
  }).parse(req.body);
  const [s] = await db.update(schema.services).set(b)
    .where(and(eq(schema.services.id, req.params.id), eq(schema.services.clinicId, clinicId))).returning();
  if (!s) throw notFound();
  res.json(s);
}));

// ---------------- Team (owner) ----------------

clinicRouter.get("/team", ownerOnly, ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const rows = await db.query.users.findMany({ where: eq(schema.users.clinicId, clinicId), orderBy: asc(schema.users.name) });
  res.json(rows.map(publicUser).map((u, i) => ({ ...u, active: rows[i].active, lastLoginAt: rows[i].lastLoginAt })));
}));

clinicRouter.post("/team", ownerOnly, ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const b = z.object({
    email: z.string().email(), name: z.string().min(1), password: z.string().min(10), role: z.enum(["CLINIC_OWNER", "CLINIC_STAFF"]),
  }).parse(req.body);
  const [u] = await db.insert(schema.users).values({
    clinicId, email: b.email.toLowerCase(), name: b.name, role: b.role, passwordHash: await bcrypt.hash(b.password, 12),
  }).returning();
  await audit(req, { action: "CREATE_USER", entity: "user", entityId: u.id, clinicId });
  res.status(201).json(publicUser(u));
}));

clinicRouter.patch("/team/:id", ownerOnly, ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const b = z.object({ active: z.boolean().optional(), role: z.enum(["CLINIC_OWNER", "CLINIC_STAFF"]).optional(), name: z.string().optional() }).parse(req.body);
  if (req.params.id === req.user!.id && b.active === false) throw badRequest("You can't disable yourself");
  const [u] = await db.update(schema.users).set(b)
    .where(and(eq(schema.users.id, req.params.id), eq(schema.users.clinicId, clinicId))).returning();
  if (!u) throw notFound();
  if (b.active === false) await db.update(schema.sessions).set({ revokedAt: new Date() }).where(eq(schema.sessions.userId, u.id));
  await audit(req, { action: "UPDATE_USER", entity: "user", entityId: u.id, clinicId, meta: b });
  res.json(publicUser(u));
}));

// ---------------- Audit log (owner) ----------------

clinicRouter.get("/audit-logs", ownerOnly, ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const f = z.object({ actor: z.string().optional(), q: z.string().optional() }).parse(req.query);
  const rows = await db.query.auditLogs.findMany({
    where: and(
      eq(schema.auditLogs.clinicId, clinicId),
      f.actor ? eq(schema.auditLogs.actor, f.actor) : undefined,
      f.q ? ilike(schema.auditLogs.action, `%${f.q.replace(/\s+/g, "_")}%`) : undefined,
    ),
    orderBy: desc(schema.auditLogs.createdAt),
    limit: 500,
  });
  res.json(rows);
}));

// ---------------- Next free slots (used by staff "find a time" button) ----------------

clinicRouter.get("/next-slots", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const q = z.object({ serviceId: z.string().optional(), providerId: z.string().optional(), limit: z.coerce.number().optional() }).parse(req.query);
  res.json(await findNextSlots({ clinicId, ...q }));
}));
