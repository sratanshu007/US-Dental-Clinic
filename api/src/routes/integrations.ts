// Owner-only: billing (plan, usage, Stripe checkout/portal) and practice software (Open Dental) settings.
import { Router } from "express";
import { z } from "zod";
import { db, schema } from "../db";
import { eq } from "drizzle-orm";
import { audit } from "../lib/audit";
import { encrypt } from "../lib/crypto";
import { ah, badRequest } from "../lib/http";
import { clinicScope, requireAuth, requireRole } from "../middleware/auth";
import { createCheckout, createPortal, usageSummary } from "../services/billing";
import { planOf, PLANS } from "../services/plans";
import { pullBusy, pushAppointment, testConnection } from "../services/pms";
import { getClinic } from "../services/scheduling";

export const integrationsRouter = Router();
integrationsRouter.use(requireAuth, requireRole("CLINIC_OWNER", "SUPER_ADMIN"));

// ---------------- Billing ----------------

integrationsRouter.get("/billing", ah(async (req, res) => {
  const clinic = await getClinic(clinicScope(req));
  const history = await db.query.usagePeriods.findMany({ where: eq(schema.usagePeriods.clinicId, clinic.id) });
  res.json({
    usage: await usageSummary(clinic),
    plans: PLANS,
    current: { plan: clinic.plan, ...planOf(clinic), billingStatus: clinic.billingStatus, hasCard: !!clinic.stripeSubscriptionId },
    history: history.sort((a, b) => b.period.localeCompare(a.period)).slice(0, 12),
  });
}));

integrationsRouter.post("/billing/checkout", ah(async (req, res) => {
  const clinic = await getClinic(clinicScope(req));
  const b = z.object({
    plan: z.enum(["STARTER", "GROWTH", "PRO"]),
    setup: z.enum(["STANDARD", "PREMIUM", "NONE"]).default("STANDARD"),
    email: z.string().email().optional(),
  }).parse(req.body);
  // Founding / waived setup is decided by Deific (super admin), not by the clinic
  if (b.setup === "NONE" && req.user!.role !== "SUPER_ADMIN") b.setup = "STANDARD";
  res.json(await createCheckout(clinic, b));
}));

integrationsRouter.post("/billing/portal", ah(async (req, res) => {
  res.json(await createPortal(await getClinic(clinicScope(req))));
}));

// ---------------- Practice management software ----------------

integrationsRouter.get("/pms", ah(async (req, res) => {
  const c = await getClinic(clinicScope(req));
  res.json({
    type: c.pmsType, connected: !!c.pmsCustomerKeyEnc, clinicNum: c.pmsClinicNum, operatoryNum: c.pmsOperatoryNum,
    providerMap: c.pmsProviderMap, lastSyncAt: c.pmsLastSyncAt, error: c.pmsSyncError, allowed: planOf(c).pmsSync,
  });
}));

integrationsRouter.put("/pms", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const c = await getClinic(clinicId);
  const b = z.object({
    type: z.enum(["NONE", "OPEN_DENTAL"]),
    customerKey: z.string().min(8).max(200).optional(),
    clinicNum: z.number().int().positive().nullable().optional(),
    operatoryNum: z.number().int().positive().nullable().optional(),
    providerMap: z.record(z.string(), z.number().int().positive()).optional(),
  }).parse(req.body);
  if (b.type !== "NONE" && !planOf(c).pmsSync) throw badRequest("Practice software sync is included in the Growth and Pro plans.");
  const [updated] = await db.update(schema.clinics).set({
    pmsType: b.type,
    ...(b.customerKey ? { pmsCustomerKeyEnc: encrypt(b.customerKey) } : {}),
    ...(b.type === "NONE" ? { pmsCustomerKeyEnc: null, pmsSyncError: null } : {}),
    ...(b.clinicNum !== undefined ? { pmsClinicNum: b.clinicNum } : {}),
    ...(b.operatoryNum !== undefined ? { pmsOperatoryNum: b.operatoryNum } : {}),
    ...(b.providerMap ? { pmsProviderMap: b.providerMap } : {}),
  }).where(eq(schema.clinics.id, clinicId)).returning();
  if (b.type === "NONE") await db.delete(schema.pmsBusyBlocks).where(eq(schema.pmsBusyBlocks.clinicId, clinicId));
  await audit(req, { action: "UPDATE_PMS", clinicId, meta: { type: b.type, keyChanged: !!b.customerKey } });
  res.json({ ok: true, type: updated.pmsType, connected: !!updated.pmsCustomerKeyEnc });
}));

/** Checks the key and lists Open Dental providers + operatories for mapping. */
integrationsRouter.post("/pms/test", ah(async (req, res) => {
  const c = await getClinic(clinicScope(req));
  try {
    res.json({ ok: true, ...(await testConnection(c)) });
  } catch (e) {
    res.json({ ok: false, error: (e as Error).message });
  }
}));

integrationsRouter.post("/pms/sync", ah(async (req, res) => {
  const c = await getClinic(clinicScope(req));
  try {
    const busy = await pullBusy(c);
    await db.update(schema.clinics).set({ pmsLastSyncAt: new Date(), pmsSyncError: null }).where(eq(schema.clinics.id, c.id));
    res.json({ ok: true, busyAppointments: busy });
  } catch (e) {
    res.json({ ok: false, error: (e as Error).message });
  }
}));

/** Retry one appointment that failed to sync. */
integrationsRouter.post("/pms/push/:appointmentId", ah(async (req, res) => {
  const c = await getClinic(clinicScope(req));
  const a = await db.query.appointments.findFirst({ where: eq(schema.appointments.id, req.params.appointmentId) });
  if (!a || a.clinicId !== c.id) throw badRequest("Unknown appointment");
  try {
    await pushAppointment(c.id, a.id, a.rescheduledFromId ?? undefined);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: (e as Error).message });
  }
}));
