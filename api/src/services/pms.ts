// Open Dental sync (https://api.opendental.com/api/v1).
//
//  * Pull: every few minutes we read the office's scheduled appointments for the next weeks and keep
//    only their times + provider as "busy blocks", so the AI never offers a slot that is taken in
//    Open Dental. No patient data from Open Dental is stored.
//  * Push: every booking, reschedule and cancellation the AI makes is written into Open Dental
//    (patient found or created, appointment created / moved / broken).
//
// Auth: "Authorization: ODFHIR {DeveloperKey}/{CustomerKey}". The developer key is ours (from Open
// Dental's Developer Portal); each office creates a customer key in Setup > Advanced Setup > API.
// Requests are relayed to the office through its eConnector, so the office PC must be on and online.
import { and, eq, gte, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { config } from "../config";
import { db, schema } from "../db";
import type { Clinic } from "../db/schema";
import { audit } from "../lib/audit";
import { decrypt } from "../lib/crypto";
import { formatUsPhone } from "../lib/phone";
import { features } from "./plans";

const OD_FORMAT = "yyyy-MM-dd HH:mm:ss";
const BUSY_STATUSES = new Set(["Scheduled", "Complete", "ASAP"]);
const PULL_DAYS = 28;

export class PmsError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

interface OdAppointment {
  AptNum: number;
  PatNum: number;
  AptStatus: string;
  Pattern: string;
  AptDateTime: string;
  ProvNum: number;
  Op: number;
  ClinicNum?: number;
}

export function odClient(customerKey: string) {
  const base = config.openDental.apiUrl.replace(/\/$/, "");
  const auth = `ODFHIR ${config.openDental.developerKey}/${customerKey}`;
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await r.text();
    // Never put response bodies in errors: they may contain patient data
    if (!r.ok) throw new PmsError(`Open Dental ${method} ${path.split("?")[0]} failed (${r.status})`, r.status);
    return (text ? JSON.parse(text) : null) as T;
  }
  return {
    get: <T>(path: string) => request<T>("GET", path),
    post: <T>(path: string, body: unknown) => request<T>("POST", path, body),
    put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  };
}

function clientFor(clinic: Clinic) {
  if (clinic.pmsType !== "OPEN_DENTAL") throw new PmsError("PMS sync is off for this clinic");
  if (!config.openDental.developerKey) throw new PmsError("OPEN_DENTAL_DEVELOPER_KEY is not set");
  const key = decrypt(clinic.pmsCustomerKeyEnc);
  if (!key) throw new PmsError("Customer key missing");
  return odClient(key);
}

/** Pattern is one character per 5 minutes; "X" = provider time. */
export const patternFor = (minutes: number) => "X".repeat(Math.max(1, Math.round(minutes / 5)));
export const patternMinutes = (pattern: string) => Math.max(5, (pattern || "").length * 5);

const qs = (o: Record<string, string | number | undefined | null>) =>
  Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");

/** For the settings screen: verifies the key and returns providers + operatories to map. */
export async function testConnection(clinic: Clinic) {
  const od = clientFor(clinic);
  const providers = await od.get<Array<{ ProvNum: number; Abbr?: string; FName?: string; LName?: string; IsHidden?: string }>>("/providers");
  const ops = await od.get<Array<{ OperatoryNum: number; OpName?: string; Abbrev?: string; IsHidden?: string; ClinicNum?: number }>>(
    `/operatories${clinic.pmsClinicNum ? `?${qs({ ClinicNum: clinic.pmsClinicNum })}` : ""}`,
  );
  return {
    providers: (providers ?? []).filter((p) => p.IsHidden !== "true").map((p) => ({ provNum: p.ProvNum, name: [p.FName, p.LName].filter(Boolean).join(" ") || p.Abbr || `#${p.ProvNum}` })),
    operatories: (ops ?? []).filter((o) => o.IsHidden !== "true").map((o) => ({ opNum: o.OperatoryNum, name: o.OpName || o.Abbrev || `#${o.OperatoryNum}` })),
  };
}

/** Pull busy times for the next PULL_DAYS days. */
export async function pullBusy(clinic: Clinic): Promise<number> {
  const od = clientFor(clinic);
  const now = DateTime.now().setZone(clinic.timezone).startOf("day");
  const end = now.plus({ days: PULL_DAYS });
  const all: OdAppointment[] = [];
  for (let offset = 0; offset < 5000; ) {
    const page = await od.get<OdAppointment[]>(`/appointments?${qs({
      dateStart: now.toISODate(), dateEnd: end.toISODate(), ClinicNum: clinic.pmsClinicNum, Offset: offset || undefined,
    })}`);
    if (!page?.length) break;
    all.push(...page);
    if (page.length < 100) break; // Open Dental pages at 100
    offset += page.length;
  }
  const byProv = new Map(Object.entries(clinic.pmsProviderMap ?? {}).map(([ours, prov]) => [Number(prov), ours]));
  const keep = all.filter((a) => BUSY_STATUSES.has(a.AptStatus));
  for (const a of keep) {
    const start = DateTime.fromFormat(a.AptDateTime, OD_FORMAT, { zone: clinic.timezone });
    if (!start.isValid) continue;
    const row = {
      clinicId: clinic.id, pmsAptNum: a.AptNum, providerId: byProv.get(a.ProvNum) ?? null,
      startAt: start.toJSDate(), endAt: start.plus({ minutes: patternMinutes(a.Pattern) }).toJSDate(),
    };
    await db.insert(schema.pmsBusyBlocks).values(row).onConflictDoUpdate({
      target: [schema.pmsBusyBlocks.clinicId, schema.pmsBusyBlocks.pmsAptNum],
      set: { providerId: row.providerId, startAt: row.startAt, endAt: row.endAt, updatedAt: new Date() },
    });
  }
  // Remove blocks in the window that no longer exist (cancelled / moved out in Open Dental)
  const ids = keep.map((a) => a.AptNum);
  await db.delete(schema.pmsBusyBlocks).where(and(
    eq(schema.pmsBusyBlocks.clinicId, clinic.id),
    gte(schema.pmsBusyBlocks.startAt, now.toJSDate()),
    lt(schema.pmsBusyBlocks.startAt, end.toJSDate()),
    ...(ids.length ? [notInArray(schema.pmsBusyBlocks.pmsAptNum, ids)] : []),
  ));
  // Old blocks are useless
  await db.delete(schema.pmsBusyBlocks).where(and(eq(schema.pmsBusyBlocks.clinicId, clinic.id), lt(schema.pmsBusyBlocks.endAt, now.toJSDate())));
  return keep.length;
}

async function ensurePatient(clinic: Clinic, od: ReturnType<typeof odClient>, patientId: string): Promise<number> {
  const p = await db.query.patients.findFirst({ where: eq(schema.patients.id, patientId) });
  if (!p) throw new PmsError("Patient not found");
  if (p.pmsPatNum) return p.pmsPatNum;
  const dob = decrypt(p.dobEnc);
  const phone = formatUsPhone(p.phone); // "(210) 555-1234"
  let match: number | undefined;
  if (p.firstName && p.lastName && dob) {
    const found = await od.get<Array<{ PatNum: number }>>(`/patients/Simple?${qs({ LName: p.lastName, FName: p.firstName, Birthdate: dob })}`);
    if (found?.length === 1) match = found[0].PatNum;
  }
  if (!match && p.firstName && p.lastName) {
    const found = await od.get<Array<{ PatNum: number; LName?: string; FName?: string }>>(`/patients/Simple?${qs({ LName: p.lastName, FName: p.firstName, WirelessPhone: phone })}`);
    if (found?.length === 1) match = found[0].PatNum;
  }
  if (!match) {
    const created = await od.post<{ PatNum: number }>("/patients", {
      LName: p.lastName || "Unknown", FName: p.firstName || "Unknown", WirelessPhone: phone,
      ...(dob ? { Birthdate: dob } : {}), ...(p.email ? { Email: p.email } : {}),
      TxtMsgOk: p.smsConsent && !p.smsOptOut ? "Yes" : "No",
      ...(clinic.pmsClinicNum ? { ClinicNum: clinic.pmsClinicNum } : {}),
    });
    match = created.PatNum;
  }
  await db.update(schema.patients).set({ pmsPatNum: match }).where(eq(schema.patients.id, p.id));
  return match;
}

/** Write one of our appointments into Open Dental (create, move or break). Safe to call repeatedly. */
export async function pushAppointment(clinicId: string, appointmentId: string, replacedId?: string): Promise<void> {
  const clinic = await db.query.clinics.findFirst({ where: eq(schema.clinics.id, clinicId) });
  if (!clinic || clinic.pmsType !== "OPEN_DENTAL" || !features(clinic).pmsSync) return;
  const appt = await db.query.appointments.findFirst({ where: eq(schema.appointments.id, appointmentId), with: { service: true } });
  if (!appt) return;
  try {
    const od = clientFor(clinic);
    if (appt.status === "CANCELLED") {
      if (appt.pmsAptNum) await od.put(`/appointments/${appt.pmsAptNum}/Break`, { sendToUnscheduledList: "true" });
    } else {
      const local = DateTime.fromJSDate(appt.startAt).setZone(clinic.timezone).toFormat(OD_FORMAT);
      const minutes = Math.round((appt.endAt.getTime() - appt.startAt.getTime()) / 60000);
      const provNum = appt.providerId ? clinic.pmsProviderMap?.[appt.providerId] : undefined;
      const replaced = replacedId ? await db.query.appointments.findFirst({ where: eq(schema.appointments.id, replacedId) }) : null;
      const existingNum = appt.pmsAptNum ?? replaced?.pmsAptNum ?? null;
      if (existingNum) {
        await od.put(`/appointments/${existingNum}`, {
          AptDateTime: local, Pattern: patternFor(minutes), ...(provNum ? { ProvNum: provNum } : {}),
        });
        if (!appt.pmsAptNum) await db.update(schema.appointments).set({ pmsAptNum: existingNum }).where(eq(schema.appointments.id, appt.id));
      } else {
        if (!clinic.pmsOperatoryNum) throw new PmsError("Choose an operatory for AI bookings in Settings");
        const patNum = await ensurePatient(clinic, od, appt.patientId);
        const created = await od.post<{ AptNum: number }>("/appointments", {
          PatNum: patNum, Op: clinic.pmsOperatoryNum, AptDateTime: local, Pattern: patternFor(minutes),
          ...(provNum ? { ProvNum: provNum } : {}), ...(clinic.pmsClinicNum ? { ClinicNum: clinic.pmsClinicNum } : {}),
          Note: `Booked by AI receptionist${appt.service?.name ? ` — ${appt.service.name}` : ""}${appt.reason ? `: ${appt.reason}` : ""}`.slice(0, 250),
        });
        await db.update(schema.appointments).set({ pmsAptNum: created.AptNum }).where(eq(schema.appointments.id, appt.id));
      }
      if (replaced?.pmsAptNum) await db.update(schema.appointments).set({ pmsAptNum: null, pmsSyncedAt: new Date() }).where(eq(schema.appointments.id, replaced.id));
    }
    await db.update(schema.appointments).set({ pmsSyncedAt: new Date(), pmsError: null }).where(eq(schema.appointments.id, appt.id));
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    await db.update(schema.appointments).set({ pmsError: msg }).where(eq(schema.appointments.id, appt.id));
    throw e;
  }
}

/** Job: pull busy times and retry unsynced bookings for every connected clinic. */
export async function syncAllPms(): Promise<void> {
  if (!config.openDental.developerKey) return;
  const clinics = await db.query.clinics.findMany({ where: and(eq(schema.clinics.active, true), eq(schema.clinics.pmsType, "OPEN_DENTAL")) });
  for (const clinic of clinics) {
    if (!features(clinic).pmsSync) continue;
    try {
      await pullBusy(clinic);
      const pending = await db.query.appointments.findMany({
        where: and(
          eq(schema.appointments.clinicId, clinic.id),
          isNull(schema.appointments.pmsSyncedAt),
          gte(schema.appointments.startAt, new Date()),
          or(
            sql`${schema.appointments.status} in ('BOOKED','CONFIRMED')`,
            and(eq(schema.appointments.status, "CANCELLED"), sql`${schema.appointments.pmsAptNum} is not null`),
          ),
        ),
        limit: 50,
      });
      for (const a of pending) {
        try { await pushAppointment(clinic.id, a.id, a.rescheduledFromId ?? undefined); } catch { /* recorded on the row */ }
      }
      await db.update(schema.clinics).set({ pmsLastSyncAt: new Date(), pmsSyncError: null }).where(eq(schema.clinics.id, clinic.id));
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      if (clinic.pmsSyncError !== msg) {
        await audit(null, { action: "PMS_SYNC_FAILED", entity: "clinic", entityId: clinic.id, clinicId: clinic.id, meta: { error: msg } }, "system");
      }
      await db.update(schema.clinics).set({ pmsSyncError: msg }).where(eq(schema.clinics.id, clinic.id));
    }
  }
}
