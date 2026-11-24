// v3: plans, billing, Open Dental sync, call opt-out, extra numbers, renaming protection.
// Run: JOBS_ENABLED=false npm test
import "./_env";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import Stripe from "stripe";
import { and, eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { createApp } from "../src/app";
import { db, pool, schema } from "../src/db";
import type { Clinic } from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { dispatchOutbound } from "../src/jobs";
import { DEFAULT_HOURS } from "../src/routes/admin";
import { closePeriod, usageSummary } from "../src/services/billing";
import { pullBusy, pushAppointment } from "../src/services/pms";
import { getAvailability, setAppointmentStatus } from "../src/services/scheduling";

const KEY = process.env.INTERNAL_API_KEY ?? "dev-internal-key";
const rnd = () => String(Math.floor(Math.random() * 9000) + 1000);
const OPEN_ALL = { ...DEFAULT_HOURS, fri: [["08:00", "17:00"]], sat: [["08:00", "17:00"]], sun: [["08:00", "17:00"]] } as any;
let server: Server;
let base = "";
let odServer: Server;

async function internal(path: string, body: unknown) {
  const r = await fetch(`${base}/internal${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Internal-Key": KEY }, body: JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : null };
}

// ---------- mock Open Dental ----------
const od = {
  apts: [] as any[], patients: [] as any[], calls: [] as string[], nextApt: 900, nextPat: 500, authOk: true,
};
function startOd() {
  return new Promise<void>((resolve) => {
    odServer = http.createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      const url = new URL(req.url!, "http://x");
      od.calls.push(`${req.method} ${url.pathname}`);
      od.authOk = od.authOk && req.headers.authorization === "ODFHIR devkey123/custkey-abc";
      const send = (code: number, data?: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(data === undefined ? "" : JSON.stringify(data)); };
      const p = url.pathname.replace("/api/v1", "");
      if (req.method === "GET" && p === "/appointments") return send(200, od.apts.filter((a) => a.AptDateTime.slice(0, 10) >= url.searchParams.get("dateStart")!));
      if (req.method === "GET" && p === "/patients/Simple") return send(200, od.patients.filter((x) => x.LName === url.searchParams.get("LName") && x.FName === url.searchParams.get("FName")));
      if (req.method === "POST" && p === "/patients") { const x = { PatNum: od.nextPat++, ...JSON.parse(body) }; od.patients.push(x); return send(201, x); }
      if (req.method === "POST" && p === "/appointments") { const x = { AptNum: od.nextApt++, AptStatus: "Scheduled", ...JSON.parse(body) }; od.apts.push(x); return send(201, x); }
      const m = p.match(/^\/appointments\/(\d+)(\/Break)?$/);
      if (req.method === "PUT" && m) {
        const a = od.apts.find((x) => x.AptNum === Number(m[1]));
        if (!a) return send(404);
        if (m[2]) a.AptStatus = "Broken"; else Object.assign(a, JSON.parse(body));
        return send(200, a);
      }
      if (req.method === "GET" && p === "/providers") return send(200, [{ ProvNum: 10, FName: "Ana", LName: "Diaz" }]);
      if (req.method === "GET" && p === "/operatories") return send(200, [{ OperatoryNum: 5, OpName: "Op 1" }]);
      send(404);
    }).listen(47811, "127.0.0.1", () => resolve());
  });
}

let growth: Clinic;
let provA = "";
const CLINIC_NUM = `+1830558${rnd()}`;
const CALLER = `+1210558${rnd()}`;

before(async () => {
  await startOd();
  [growth] = await db.insert(schema.clinics).values({
    name: "Sync Dental", aiPhoneNumber: CLINIC_NUM, timezone: "America/Chicago", businessHours: OPEN_ALL,
    plan: "GROWTH", pmsType: "OPEN_DENTAL", pmsCustomerKeyEnc: encrypt("custkey-abc"), pmsOperatoryNum: 5,
  }).returning();
  const [p] = await db.insert(schema.providers).values({ clinicId: growth.id, name: "Dr. Diaz" }).returning();
  provA = p.id;
  [growth] = await db.update(schema.clinics).set({ pmsProviderMap: { [provA]: 10 } }).where(eq(schema.clinics.id, growth.id)).returning();
  await db.insert(schema.services).values({ clinicId: growth.id, name: "Cleaning", durationMin: 60 });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  odServer.close();
  await pool.end();
});

const tomorrow = () => DateTime.now().setZone("America/Chicago").plus({ days: 1 }).toISODate()!;

test("Open Dental: busy times block AI slots", async () => {
  od.apts.push({ AptNum: 77, PatNum: 1, AptStatus: "Scheduled", Pattern: "X".repeat(12), AptDateTime: `${tomorrow()} 10:00:00`, ProvNum: 10, Op: 5 });
  od.apts.push({ AptNum: 78, PatNum: 2, AptStatus: "Broken", Pattern: "XXXXXX", AptDateTime: `${tomorrow()} 13:00:00`, ProvNum: 10, Op: 5 });
  const n = await pullBusy(growth);
  assert.equal(n, 1, "broken appointments don't block");
  assert.ok(od.authOk, "ODFHIR developer/customer key header");
  const slots = (await getAvailability({ clinicId: growth.id, date: tomorrow() })).map((s) => DateTime.fromISO(s.startAt).setZone("America/Chicago").toFormat("HH:mm"));
  assert.ok(!slots.includes("10:00") && !slots.includes("10:30"), "10:00–11:00 is busy in Open Dental");
  assert.ok(slots.includes("11:00") && slots.includes("13:00"), "free times still offered");
});

let apptId = "";
test("Open Dental: AI booking is written back (patient + appointment)", async () => {
  const start = await internal("/calls/start", { direction: "INBOUND", from: CALLER, to: CLINIC_NUM });
  const at = DateTime.fromISO(`${tomorrow()}T14:00`, { zone: "America/Chicago" }).toUTC().toISO()!;
  const svc = start.json.services[0].id;
  const b = await internal("/tools/book_appointment", {
    callId: start.json.callId, args: { startAt: at, firstName: "Lena", lastName: "Park", serviceId: svc, dateOfBirth: "1991-07-04", callConsent: true, reason: "cleaning" },
  });
  assert.equal(b.json.ok, true, JSON.stringify(b.json));
  apptId = b.json.appointmentId;
  await pushAppointment(growth.id, apptId);
  const pat = od.patients.find((x) => x.FName === "Lena");
  assert.ok(pat, "patient created in Open Dental");
  assert.equal(pat.Birthdate, "1991-07-04");
  const apt = od.apts.find((x) => x.PatNum === pat.PatNum);
  assert.equal(apt.AptDateTime, `${tomorrow()} 14:00:00`, "clinic-local time");
  assert.equal(apt.Pattern, "X".repeat(12));
  assert.equal(apt.ProvNum, 10);
  assert.equal(apt.Op, 5);
  const row = await db.query.appointments.findFirst({ where: eq(schema.appointments.id, apptId) });
  assert.equal(row!.pmsAptNum, apt.AptNum);
  assert.ok(row!.pmsSyncedAt);
  // Pulling again doesn't double count our own booking
  await pullBusy(growth);
  const slots = await getAvailability({ clinicId: growth.id, date: tomorrow(), excludeAppointmentId: apptId });
  assert.ok(slots.some((s) => DateTime.fromISO(s.startAt).setZone("America/Chicago").toFormat("HH:mm") === "14:00"), "excluded booking frees its slot");
});

test("Open Dental: cancel breaks the appointment", async () => {
  await setAppointmentStatus(growth.id, apptId, "CANCELLED");
  await pushAppointment(growth.id, apptId);
  const row = await db.query.appointments.findFirst({ where: eq(schema.appointments.id, apptId) });
  assert.equal(od.apts.find((x) => x.AptNum === row!.pmsAptNum).AptStatus, "Broken");
});

test("unverified caller can't rename an existing patient", async () => {
  const start = await internal("/calls/start", { direction: "INBOUND", from: CALLER, to: CLINIC_NUM });
  const at = DateTime.fromISO(`${tomorrow()}T15:00`, { zone: "America/Chicago" }).toUTC().toISO()!;
  const b = await internal("/tools/book_appointment", { callId: start.json.callId, args: { startAt: at, firstName: "Mallory", lastName: "Evil" } });
  assert.equal(b.json.ok, true, JSON.stringify(b.json));
  const p = await db.query.patients.findFirst({ where: and(eq(schema.patients.clinicId, growth.id), eq(schema.patients.phone, CALLER)) });
  assert.equal(p!.firstName, "Lena");
  assert.equal(p!.lastName, "Park");
});

test("opt-out stops automated calls", async () => {
  const p = (await db.query.patients.findFirst({ where: and(eq(schema.patients.clinicId, growth.id), eq(schema.patients.phone, CALLER)) }))!;
  const [task] = await db.insert(schema.outboundTasks).values({
    clinicId: growth.id, patientId: p.id, purpose: "FEEDBACK", channel: "CALL", nextAttemptAt: new Date(Date.now() + 3600_000),
  }).returning();
  const start = await internal("/calls/start", { direction: "INBOUND", from: CALLER, to: CLINIC_NUM });
  const r = await internal("/tools/opt_out_calls", { callId: start.json.callId, args: {} });
  assert.equal(r.json.ok, true);
  const after = await db.query.patients.findFirst({ where: eq(schema.patients.id, p.id) });
  assert.equal(after!.callOptOut, true);
  assert.equal(after!.callConsent, false);
  const t = await db.query.outboundTasks.findFirst({ where: eq(schema.outboundTasks.id, task.id) });
  assert.equal(t!.status, "CANCELLED");
});

test("Starter plan: no automated no-show calls; Pro: extra numbers route to the clinic", async () => {
  const [starter] = await db.insert(schema.clinics).values({ name: "Small Dental", aiPhoneNumber: `+1830559${rnd()}`, businessHours: OPEN_ALL, plan: "STARTER" }).returning();
  const [pt] = await db.insert(schema.patients).values({ clinicId: starter.id, phone: `+1210559${rnd()}`, firstName: "Al", callConsent: true }).returning();
  const [a] = await db.insert(schema.appointments).values({
    clinicId: starter.id, patientId: pt.id, startAt: new Date(Date.now() - 3 * 3600_000), endAt: new Date(Date.now() - 2 * 3600_000), source: "STAFF",
  }).returning();
  await setAppointmentStatus(starter.id, a.id, "NO_SHOW");
  const tasks = await db.query.outboundTasks.findMany({ where: eq(schema.outboundTasks.appointmentId, a.id) });
  assert.equal(tasks.length, 0, "no-show calls are a Growth/Pro feature");

  const [pro] = await db.insert(schema.clinics).values({ name: "Big Dental", aiPhoneNumber: `+1830560${rnd()}`, businessHours: OPEN_ALL, plan: "PRO" }).returning();
  const extra = `+1830561${rnd()}`;
  await db.insert(schema.clinicNumbers).values({ clinicId: pro.id, number: extra, label: "Spanish line" });
  const s = await internal("/calls/start", { direction: "INBOUND", from: `+1210561${rnd()}`, to: extra });
  assert.equal(s.status, 200);
  assert.equal(s.json.clinic.name, "Big Dental");

  // Canceled billing turns the AI line off
  await db.update(schema.clinics).set({ billingStatus: "CANCELED" }).where(eq(schema.clinics.id, pro.id));
  const off = await internal("/calls/start", { direction: "INBOUND", from: `+1210561${rnd()}`, to: extra });
  assert.equal(off.status, 404);
});

test("usage: minutes per month, overage, manual billing period close", async () => {
  const [c] = await db.insert(schema.clinics).values({ name: "Usage Dental", aiPhoneNumber: `+1830562${rnd()}`, businessHours: OPEN_ALL, plan: "STARTER", minutesIncluded: 2 }).returning();
  const lastMonth = DateTime.now().setZone(c.timezone).minus({ months: 1 }).set({ day: 10, hour: 12 });
  for (const sec of [61, 130, 30]) { // rounds up per call: 2 + 3 + 1 = 6 min
    await db.insert(schema.calls).values({ clinicId: c.id, direction: "INBOUND", fromNumber: "+12105550000", toNumber: c.aiPhoneNumber, durationSec: sec, startedAt: lastMonth.toJSDate() });
  }
  const period = lastMonth.toFormat("yyyy-LL");
  const u = await usageSummary(c, period);
  assert.equal(u.minutes, 6);
  assert.equal(u.overageMinutes, 4);
  assert.equal(u.overageCents, 60);
  const row = await closePeriod(c, period);
  assert.equal(row.overageCents, 60);
  assert.equal(row.invoicedAt, null, "manual clinics: recorded, waiting for you to invoice");
});

test("Stripe webhook: signature checked, checkout activates the plan", async () => {
  const [c] = await db.insert(schema.clinics).values({ name: "Card Dental", aiPhoneNumber: `+1830563${rnd()}`, businessHours: OPEN_ALL, plan: "STARTER" }).returning();
  const payload = JSON.stringify({
    id: "evt_1", object: "event", type: "checkout.session.completed",
    data: { object: { id: "cs_1", object: "checkout.session", customer: "cus_123", subscription: "sub_123", metadata: { clinicId: c.id, plan: "PRO" } } },
  });
  const bad = await fetch(`${base}/webhooks/stripe`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": "t=1,v1=bad" }, body: payload });
  assert.equal(bad.status, 400);
  const sig = new Stripe("sk_test_dummy").webhooks.generateTestHeaderString({ payload, secret: "whsec_test_secret" });
  const ok = await fetch(`${base}/webhooks/stripe`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": sig }, body: payload });
  assert.equal(ok.status, 200, await ok.text());
  const after = await db.query.clinics.findFirst({ where: eq(schema.clinics.id, c.id) });
  assert.equal(after!.billingStatus, "ACTIVE");
  assert.equal(after!.plan, "PRO");
  assert.equal(after!.stripeCustomerId, "cus_123");
});

test("readiness endpoint checks the database", async () => {
  const r = await fetch(`${base}/ready`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).db, "ok");
});

test("dispatch skips patients who opted out", async () => {
  await dispatchOutbound(); // must not throw
});

test("texts only for booked appointments: no-show / feedback texts are skipped by default", async () => {
  const [c] = await db.insert(schema.clinics).values({ name: "Quiet Dental", aiPhoneNumber: `+1830564${rnd()}`, businessHours: OPEN_ALL, callingHoursStart: "00:00", callingHoursEnd: "23:59" }).returning();
  assert.equal(c.smsOnlyBooked, true);
  const [pt] = await db.insert(schema.patients).values({ clinicId: c.id, phone: `+1210564${rnd()}`, firstName: "Al", smsConsent: true }).returning();
  const [t] = await db.insert(schema.outboundTasks).values({ clinicId: c.id, patientId: pt.id, purpose: "NO_SHOW_REBOOK", channel: "SMS", nextAttemptAt: new Date(Date.now() - 1000) }).returning();
  await dispatchOutbound();
  const after = await db.query.outboundTasks.findFirst({ where: eq(schema.outboundTasks.id, t.id) });
  assert.equal(after!.status, "CANCELLED");
  const sms = await db.query.smsMessages.findMany({ where: eq(schema.smsMessages.patientId, pt.id) });
  assert.equal(sms.length, 0, "no text before a booking");
});
