// Super admin (Deific Digital) — manage all clinics.
import bcrypt from "bcryptjs";
import { Router } from "express";
import { and, asc, count, eq, gte, sql, sum } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import { db, schema } from "../db";
import type { BusinessHours } from "../db/schema";
import { audit } from "../lib/audit";
import { ah, badRequest, notFound } from "../lib/http";
import { normalizeUsPhone } from "../lib/phone";
import { requireAuth, requireRole, requireAdminMfa } from "../middleware/auth";
import { publicUser } from "./auth";
import { newPassword } from "../lib/password";
import { usageSummary } from "../services/billing";
import { planOf } from "../services/plans";

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole("SUPER_ADMIN"), requireAdminMfa);

export const DEFAULT_HOURS: BusinessHours = {
  mon: [["08:00", "17:00"]], tue: [["08:00", "17:00"]], wed: [["08:00", "17:00"]],
  thu: [["08:00", "17:00"]], fri: [["08:00", "14:00"]], sat: [], sun: [],
};

adminRouter.get("/clinics", ah(async (_req, res) => {
  const monthStart = DateTime.now().startOf("month").toJSDate();
  const clinics = await db.query.clinics.findMany({ orderBy: asc(schema.clinics.name) });
  const usage = await db
    .select({
      clinicId: schema.calls.clinicId,
      calls: count(),
      seconds: sum(schema.calls.durationSec),
    })
    .from(schema.calls)
    .where(gte(schema.calls.startedAt, monthStart))
    .groupBy(schema.calls.clinicId);
  const bookings = await db
    .select({ clinicId: schema.appointments.clinicId, n: count() })
    .from(schema.appointments)
    .where(and(gte(schema.appointments.createdAt, monthStart), sql`${schema.appointments.source} <> 'STAFF'`))
    .groupBy(schema.appointments.clinicId);
  res.json(clinics.map((c) => {
    const u = usage.find((x) => x.clinicId === c.id);
    const b = bookings.find((x) => x.clinicId === c.id);
    return {
      id: c.id, name: c.name, aiPhoneNumber: c.aiPhoneNumber, timezone: c.timezone, active: c.active, aiEnabled: c.aiEnabled,
      createdAt: c.createdAt, plan: c.plan, billingStatus: c.billingStatus, pmsType: c.pmsType, pmsSyncError: c.pmsSyncError,
      thisMonth: { calls: Number(u?.calls ?? 0), minutes: Math.round(Number(u?.seconds ?? 0) / 60), aiBookings: Number(b?.n ?? 0) },
    };
  }));
}));

adminRouter.post("/clinics", ah(async (req, res) => {
  const b = z.object({
    name: z.string().min(2),
    aiPhoneNumber: z.string(),
    timezone: z.string().default("America/Chicago"),
    address: z.string().optional(),
    transferNumber: z.string().optional(),
    owner: z.object({ name: z.string().min(1).max(100), email: z.string().email().max(200), password: newPassword }),
    plan: z.enum(["STARTER", "GROWTH", "PRO"]).default("GROWTH"),
    billingStatus: z.enum(["TRIAL", "MANUAL", "ACTIVE"]).default("TRIAL"),
  }).parse(req.body);
  const phone = normalizeUsPhone(b.aiPhoneNumber);
  if (!phone) throw badRequest("Invalid AI phone number");
  if (!DateTime.now().setZone(b.timezone).isValid) throw badRequest("Invalid timezone");
  const transfer = b.transferNumber ? normalizeUsPhone(b.transferNumber) : null;

  const result = await db.transaction(async (tx) => {
    const [clinic] = await tx.insert(schema.clinics).values({
      name: b.name, aiPhoneNumber: phone, timezone: b.timezone, address: b.address, transferNumber: transfer,
      businessHours: DEFAULT_HOURS, plan: b.plan, billingStatus: b.billingStatus,
    }).returning();
    const [owner] = await tx.insert(schema.users).values({
      clinicId: clinic.id, email: b.owner.email.toLowerCase(), name: b.owner.name, role: "CLINIC_OWNER",
      passwordHash: await bcrypt.hash(b.owner.password, 12),
    }).returning();
    await tx.insert(schema.services).values([
      { clinicId: clinic.id, name: "New patient exam & cleaning", durationMin: 60 },
      { clinicId: clinic.id, name: "Cleaning", durationMin: 45 },
      { clinicId: clinic.id, name: "Emergency / tooth pain", durationMin: 30 },
      { clinicId: clinic.id, name: "Consultation", durationMin: 30 },
    ]);
    return { clinic, owner };
  });
  await audit(req, { action: "CREATE_CLINIC", entity: "clinic", entityId: result.clinic.id, clinicId: result.clinic.id });
  res.status(201).json({ clinic: result.clinic, owner: publicUser(result.owner) });
}));

adminRouter.patch("/clinics/:id", ah(async (req, res) => {
  const b = z.object({
    active: z.boolean().optional(), aiEnabled: z.boolean().optional(), aiPhoneNumber: z.string().optional(), name: z.string().optional(),
    plan: z.enum(["STARTER", "GROWTH", "PRO"]).optional(),
    billingStatus: z.enum(["TRIAL", "MANUAL", "ACTIVE", "PAST_DUE", "CANCELED"]).optional(),
    minutesIncluded: z.number().int().min(0).nullable().optional(),
    overageCentsPerMin: z.number().int().min(0).max(500).optional(),
    billingEmail: z.string().email().nullable().optional(),
  }).parse(req.body);
  if (b.aiPhoneNumber) {
    const p = normalizeUsPhone(b.aiPhoneNumber);
    if (!p) throw badRequest("Invalid phone");
    b.aiPhoneNumber = p;
  }
  const [c] = await db.update(schema.clinics).set(b).where(eq(schema.clinics.id, req.params.id)).returning();
  if (!c) throw notFound();
  await audit(req, { action: "UPDATE_CLINIC", entity: "clinic", entityId: c.id, clinicId: c.id, meta: b });
  const { pmsCustomerKeyEnc: _k, ...safe } = c;
  res.json(safe);
}));

// Extra phone numbers (Pro plan)
adminRouter.get("/clinics/:id/numbers", ah(async (req, res) => {
  res.json(await db.query.clinicNumbers.findMany({ where: eq(schema.clinicNumbers.clinicId, req.params.id) }));
}));

adminRouter.post("/clinics/:id/numbers", ah(async (req, res) => {
  const b = z.object({ number: z.string(), label: z.string().max(60).optional() }).parse(req.body);
  const n = normalizeUsPhone(b.number);
  if (!n) throw badRequest("Invalid phone");
  const clinic = await db.query.clinics.findFirst({ where: eq(schema.clinics.id, req.params.id) });
  if (!clinic) throw notFound();
  const have = await db.query.clinicNumbers.findMany({ where: eq(schema.clinicNumbers.clinicId, clinic.id) });
  if (have.length >= planOf(clinic).maxExtraNumbers) throw badRequest("This plan doesn't include more phone numbers (Pro includes 5).");
  const taken = (await db.query.clinics.findFirst({ where: eq(schema.clinics.aiPhoneNumber, n) })) || (await db.query.clinicNumbers.findFirst({ where: eq(schema.clinicNumbers.number, n) }));
  if (taken) throw badRequest("That number is already in use");
  const [row] = await db.insert(schema.clinicNumbers).values({ clinicId: clinic.id, number: n, label: b.label }).returning();
  await audit(req, { action: "ADD_NUMBER", entity: "clinic", entityId: clinic.id, clinicId: clinic.id });
  res.status(201).json(row);
}));

adminRouter.delete("/clinics/:id/numbers/:numberId", ah(async (req, res) => {
  await db.delete(schema.clinicNumbers).where(and(eq(schema.clinicNumbers.id, req.params.numberId), eq(schema.clinicNumbers.clinicId, req.params.id)));
  res.json({ ok: true });
}));

/** Manual billing: mark a month as invoiced after you send the invoice yourself. */
adminRouter.post("/clinics/:id/usage/:period/invoiced", ah(async (req, res) => {
  const [row] = await db.update(schema.usagePeriods).set({ invoicedAt: new Date() })
    .where(and(eq(schema.usagePeriods.clinicId, req.params.id), eq(schema.usagePeriods.period, req.params.period))).returning();
  if (!row) throw notFound();
  await audit(req, { action: "USAGE_INVOICED", entity: "clinic", entityId: req.params.id, clinicId: req.params.id, meta: { period: req.params.period } });
  res.json(row);
}));

/** Usage + billing overview for one clinic (for manual invoicing). */
adminRouter.get("/clinics/:id/usage", ah(async (req, res) => {
  const clinic = await db.query.clinics.findFirst({ where: eq(schema.clinics.id, req.params.id) });
  if (!clinic) throw notFound();
  const history = await db.query.usagePeriods.findMany({ where: eq(schema.usagePeriods.clinicId, clinic.id) });
  res.json({ current: await usageSummary(clinic), history });
}));

adminRouter.get("/clinics/:id/users", ah(async (req, res) => {
  const rows = await db.query.users.findMany({ where: eq(schema.users.clinicId, req.params.id) });
  res.json(rows.map(publicUser));
}));

adminRouter.get("/tasks", ah(async (_req, res) => {
  const rows = await db
    .select({ status: schema.outboundTasks.status, purpose: schema.outboundTasks.purpose, n: count() })
    .from(schema.outboundTasks)
    .groupBy(schema.outboundTasks.status, schema.outboundTasks.purpose);
  res.json(rows);
}));
