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
import { requireAuth, requireRole } from "../middleware/auth";
import { publicUser } from "./auth";

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole("SUPER_ADMIN"));

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
      createdAt: c.createdAt,
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
    owner: z.object({ name: z.string().min(1), email: z.string().email(), password: z.string().min(10) }),
  }).parse(req.body);
  const phone = normalizeUsPhone(b.aiPhoneNumber);
  if (!phone) throw badRequest("Invalid AI phone number");
  if (!DateTime.now().setZone(b.timezone).isValid) throw badRequest("Invalid timezone");
  const transfer = b.transferNumber ? normalizeUsPhone(b.transferNumber) : null;

  const result = await db.transaction(async (tx) => {
    const [clinic] = await tx.insert(schema.clinics).values({
      name: b.name, aiPhoneNumber: phone, timezone: b.timezone, address: b.address, transferNumber: transfer,
      businessHours: DEFAULT_HOURS,
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
  const b = z.object({ active: z.boolean().optional(), aiEnabled: z.boolean().optional(), aiPhoneNumber: z.string().optional(), name: z.string().optional() }).parse(req.body);
  if (b.aiPhoneNumber) {
    const p = normalizeUsPhone(b.aiPhoneNumber);
    if (!p) throw badRequest("Invalid phone");
    b.aiPhoneNumber = p;
  }
  const [c] = await db.update(schema.clinics).set(b).where(eq(schema.clinics.id, req.params.id)).returning();
  if (!c) throw notFound();
  await audit(req, { action: "UPDATE_CLINIC", entity: "clinic", entityId: c.id, clinicId: c.id, meta: b });
  res.json(c);
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
