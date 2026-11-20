// End-to-end API test against a real PostgreSQL database (seeded with `npm run seed`).
// Run: JOBS_ENABLED=false npm test
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { createApp } from "../src/app";
import { db, pool, schema } from "../src/db";
import { totpCode } from "../src/lib/crypto";
import { dailyReports, dispatchOutbound, sendReminders } from "../src/jobs";
import { DEFAULT_HOURS } from "../src/routes/admin";

let server: Server;
let base = "";
let token = "";
const KEY = process.env.INTERNAL_API_KEY ?? "dev-internal-key";
// Each run gets its own fresh clinic so results don't depend on earlier runs.
const CLINIC_NUMBER = `+1830555${String(Math.floor(Math.random() * 9000) + 1000)}`;
const OWNER_EMAIL = `owner-${Date.now()}@test.local`;
const OWNER_PASS = "Test-Owner-Password-1";
const CALLER = `+1210555${String(Math.floor(Math.random() * 9000) + 1000)}`;
const OTHER_CALLER = `+1210556${String(Math.floor(Math.random() * 9000) + 1000)}`;

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, json };
}
const internal = (path: string, body: unknown) => call("POST", `/internal${path}`, body, { "X-Internal-Key": KEY });

before(async () => {
  const [clinic] = await db.insert(schema.clinics).values({
    name: "Demo Family Dental", aiPhoneNumber: CLINIC_NUMBER, timezone: "America/Chicago",
    // open every day so tests pass on any weekday
    businessHours: { ...DEFAULT_HOURS, fri: [["08:00", "17:00"]], sat: [["08:00", "17:00"]], sun: [["08:00", "17:00"]] },
  }).returning();
  await db.insert(schema.providers).values([
    { clinicId: clinic.id, name: "Dr. A" }, { clinicId: clinic.id, name: "Dr. B" },
  ]);
  await db.insert(schema.services).values([
    { clinicId: clinic.id, name: "Cleaning", durationMin: 45 },
    { clinicId: clinic.id, name: "Exam", durationMin: 30 },
    { clinicId: clinic.id, name: "Emergency", durationMin: 30 },
  ]);
  await db.insert(schema.users).values({
    clinicId: clinic.id, email: OWNER_EMAIL, name: "Owner", role: "CLINIC_OWNER", passwordHash: await bcrypt.hash(OWNER_PASS, 10),
  });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  await pool.end();
});

test("login as clinic owner", async () => {
  const r = await call("POST", "/auth/login", { email: OWNER_EMAIL, password: OWNER_PASS });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  token = r.json.accessToken;
  assert.ok(token);
  const bad = await call("POST", "/auth/login", { email: OWNER_EMAIL, password: "wrong" });
  assert.equal(bad.status, 401);
});

test("internal endpoints reject a wrong key", async () => {
  const r = await call("POST", "/internal/calls/start", { direction: "INBOUND", from: CALLER, to: CLINIC_NUMBER }, { "X-Internal-Key": "nope" });
  assert.equal(r.status, 401);
});

let callId = "";
let bookedSlot = "";
let apptId = "";

test("inbound AI call: availability -> book -> double-book blocked", async () => {
  const start = await internal("/calls/start", { direction: "INBOUND", from: CALLER, to: CLINIC_NUMBER, plivoCallUuid: "test-uuid" });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  callId = start.json.callId;
  assert.equal(start.json.clinic.name, "Demo Family Dental");
  assert.equal(start.json.patient, null, "new caller is unknown");
  assert.ok(start.json.services.length >= 3);

  const avail = await internal("/tools/check_availability", { callId, args: { partOfDay: "any" } });
  assert.equal(avail.status, 200, JSON.stringify(avail.json));
  assert.ok(avail.json.slots.length > 0, "has open slots");
  bookedSlot = avail.json.slots[0].startAt;

  const cleaning = start.json.services.find((s: any) => s.name === "Cleaning");
  const booked = await internal("/tools/book_appointment", {
    callId, args: { startAt: bookedSlot, firstName: "Sarah", lastName: "Miller", serviceId: cleaning.id, reason: "cleaning", smsConsent: true },
  });
  assert.equal(booked.json.ok, true, JSON.stringify(booked.json));
  apptId = booked.json.appointmentId;

  // Fill the same slot for the 2nd provider, then a 3rd booking must fail
  const start2 = await internal("/calls/start", { direction: "INBOUND", from: OTHER_CALLER, to: CLINIC_NUMBER });
  const b2 = await internal("/tools/book_appointment", { callId: start2.json.callId, args: { startAt: bookedSlot, firstName: "Tom", serviceId: cleaning.id } });
  assert.equal(b2.json.ok, true, "second dentist takes the same time");
  const start3 = await internal("/calls/start", { direction: "INBOUND", from: "+12105557777", to: CLINIC_NUMBER });
  // (all three callers are new patients of this fresh clinic)
  const b3 = await internal("/tools/book_appointment", { callId: start3.json.callId, args: { startAt: bookedSlot, firstName: "Ann", serviceId: cleaning.id } });
  assert.equal(b3.json.ok, false, "no dentist left at that time");
});

test("identity check before sharing appointment details", async () => {
  const start = await internal("/calls/start", { direction: "INBOUND", from: CALLER, to: CLINIC_NUMBER });
  assert.deepEqual(start.json.patient.known, true);
  assert.equal(start.json.patient.firstName, undefined, "name is not revealed on inbound");
  const wrong = await internal("/tools/find_my_appointments", { callId: start.json.callId, args: { firstName: "Bob" } });
  assert.equal(wrong.json.appointments.length, 0);
  const right = await internal("/tools/find_my_appointments", { callId: start.json.callId, args: { firstName: "sarah" } });
  assert.equal(right.json.appointments.length, 1);
  assert.equal(right.json.appointments[0].appointmentId, apptId);

  // Another caller can't cancel Sarah's appointment
  const start2 = await internal("/calls/start", { direction: "INBOUND", from: OTHER_CALLER, to: CLINIC_NUMBER });
  const steal = await internal("/tools/cancel_appointment", { callId: start2.json.callId, args: { appointmentId: apptId } });
  assert.equal(steal.status, 403);
});

test("reschedule by AI moves the appointment", async () => {
  const start = await internal("/calls/start", { direction: "INBOUND", from: CALLER, to: CLINIC_NUMBER });
  const avail = await internal("/tools/check_availability", { callId: start.json.callId, args: {} });
  const newSlot = avail.json.slots.find((s: any) => s.startAt !== bookedSlot).startAt;
  const r = await internal("/tools/reschedule_appointment", { callId: start.json.callId, args: { appointmentId: apptId, newStartAt: newSlot } });
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  const old = await db.query.appointments.findFirst({ where: eq(schema.appointments.id, apptId) });
  assert.equal(old!.status, "RESCHEDULED");
  apptId = r.json.appointmentId;
});

test("lead capture + call end stores encrypted transcript", async () => {
  const lead = await internal("/tools/save_inquiry", { callId, args: { name: "Sarah Miller", interest: "Invisalign pricing" } });
  assert.equal(lead.json.ok, true);
  const end = await internal(`/calls/${callId}/end`, { transcript: "Caller: hi\nAI: hello", summary: "Booked a cleaning", durationSec: 95 });
  assert.equal(end.status, 200);
  const row = await db.query.calls.findFirst({ where: eq(schema.calls.id, callId) });
  assert.ok(row!.transcriptEnc!.startsWith("v1:"), "transcript encrypted at rest");
  const detail = await call("GET", `/api/calls/${callId}`);
  assert.equal(detail.json.summary, "Booked a cleaning");
  assert.equal(detail.json.outcome, "BOOKED");
});

test("CRM: AI inquiry creates contact + call-back task; stage, notes and tasks work", async () => {
  const list = await call("GET", "/api/crm/leads");
  assert.equal(list.status, 200, JSON.stringify(list.json));
  // Sarah was booked as a new patient (contact created), then asked about Invisalign on the same contact
  const sarahLead = list.json.leads.find((l: any) => l.phone === CALLER);
  assert.ok(sarahLead, "inquiry is in the CRM");
  const sd = await call("GET", `/api/crm/leads/${sarahLead.id}`);
  assert.ok(sd.json.activities.some((a: any) => (a.text ?? "").includes("Invisalign pricing")), "AI inquiry logged on the contact");
  assert.ok(sarahLead.nextTask, "call-back task created");
  // new patients booked by AI also appear (stage Appointment booked)
  assert.ok(list.json.leads.some((l: any) => l.stage === "APPT"), "AI booking of a new patient creates an APPT contact");

  const owners = await call("GET", "/api/crm/owners");
  const ownerId = owners.json[0].id;
  const upd = await call("PATCH", `/api/crm/leads/${sarahLead.id}`, { stage: "PLAN", value: 4800, ownerId, tags: ["Invisalign", "Hot"] });
  assert.equal(upd.status, 200, JSON.stringify(upd.json));
  assert.equal(upd.json.stage, "PLAN");
  await call("POST", `/api/crm/leads/${sarahLead.id}/activities`, { type: "NOTE", text: "Sent financing options" });
  const due = new Date(Date.now() - 3600_000).toISOString();
  const t = await call("POST", `/api/crm/leads/${sarahLead.id}/tasks`, { title: "Follow up on plan", type: "CALL", dueAt: due });
  assert.equal(t.status, 201, JSON.stringify(t.json));

  const detail = await call("GET", `/api/crm/leads/${sarahLead.id}`);
  assert.ok(detail.json.activities.some((a: any) => a.text === "Sent financing options"));
  assert.ok(detail.json.activities.some((a: any) => a.type === "STAGE"));
  const overdue = await call("GET", "/api/crm/tasks?status=overdue");
  assert.ok(overdue.json.some((x: any) => x.id === t.json.id));
  const done = await call("PATCH", `/api/crm/tasks/${t.json.id}`, { done: true });
  assert.ok(done.json.doneAt);

  const byTag = await call("GET", "/api/crm/leads?tag=Hot");
  assert.deepEqual(byTag.json.leads.map((l: any) => l.id), [sarahLead.id]);
  const won = await call("PATCH", `/api/crm/leads/${sarahLead.id}`, { stage: "WON" });
  assert.ok(won.json.closedAt);
  const sum = await call("GET", "/api/crm/summary");
  assert.equal(sum.json.wonThisMonth.value, 4800);
  assert.ok(sum.json.fromAi >= 1);

  const created = await call("POST", "/api/crm/leads", { name: "Walk In", phone: "2105551212", source: "Walk-in", value: 300 });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const bad = await call("PATCH", `/api/crm/leads/${created.json.id}`, { ownerId: "someone-else" });
  assert.equal(bad.status, 400, "owner must belong to clinic");
});

test("server-side filters on lists", async () => {
  const day = DateTime.now().setZone("America/Chicago").toISODate();
  const to = DateTime.now().setZone("America/Chicago").plus({ days: 14 }).toISODate();
  const all = await call("GET", `/api/appointments?from=${day}&to=${to}`);
  const open = await call("GET", `/api/appointments?from=${day}&to=${to}&status=OPEN`);
  assert.ok(open.json.every((a: any) => ["BOOKED", "CONFIRMED"].includes(a.status)));
  const ai = await call("GET", `/api/appointments?from=${day}&to=${to}&source=AI`);
  assert.ok(ai.json.every((a: any) => a.source !== "STAFF"));
  const search = await call("GET", `/api/appointments?from=${day}&to=${to}&q=sarah`);
  assert.ok(search.json.length >= 1 && search.json.length <= all.json.length);
  const inb = await call("GET", "/api/calls?direction=INBOUND");
  assert.ok(inb.json.length > 0 && inb.json.every((c: any) => c.direction === "INBOUND"));
  const newP = await call("GET", "/api/patients?type=new&upcoming=yes");
  assert.equal(newP.status, 200, JSON.stringify(newP.json));
  assert.ok(newP.json.every((p: any) => p.isNew && p.nextAppointmentAt));
  const leadsN = await call("GET", "/api/notifications?type=NEW_LEAD");
  assert.ok(leadsN.json.length > 0 && leadsN.json.every((n: any) => n.type === "NEW_LEAD"));
  const fb = await call("GET", "/api/feedback?rating=low");
  assert.equal(fb.status, 200);
});

test("dashboard, appointments list and notifications", async () => {
  const dash = await call("GET", "/api/dashboard");
  assert.equal(dash.status, 200, JSON.stringify(dash.json));
  assert.ok(dash.json.upcoming.length >= 1);
  const day = DateTime.fromISO(bookedSlot).setZone("America/Chicago").toISODate();
  const list = await call("GET", `/api/appointments?from=${day}&to=${DateTime.fromISO(day!).plus({ days: 14 }).toISODate()}`);
  assert.ok(list.json.some((a: any) => a.id === apptId));
  const notes = await call("GET", "/api/notifications");
  assert.ok(notes.json.some((n: any) => n.type === "NEW_BOOKING"));
  assert.ok(notes.json.some((n: any) => n.type === "NEW_LEAD"));
  for (const n of notes.json) assert.ok(!/Sarah|Miller|555/.test(n.title + n.body), "no PHI in notifications");
});

test("mark showed -> feedback task, mark no-show -> rebook task", async () => {
  const r = await call("PATCH", `/api/appointments/${apptId}/status`, { status: "SHOWED" });
  assert.equal(r.status, 200);
  const fb = await db.query.outboundTasks.findFirst({ where: eq(schema.outboundTasks.appointmentId, apptId) });
  assert.equal(fb!.purpose, "FEEDBACK");

  const r2 = await call("PATCH", `/api/appointments/${apptId}/status`, { status: "NO_SHOW" });
  assert.equal(r2.status, 200);
  const tasks = await db.query.outboundTasks.findMany({ where: eq(schema.outboundTasks.appointmentId, apptId) });
  assert.ok(tasks.some((t) => t.purpose === "NO_SHOW_REBOOK" && t.status === "PENDING"));
  assert.ok(tasks.some((t) => t.purpose === "FEEDBACK" && t.status === "CANCELLED"), "feedback cancelled after status change");
});

test("SMS replies: confirm and STOP", async () => {
  // fresh future appointment for the caller
  const start = await internal("/calls/start", { direction: "INBOUND", from: CALLER, to: CLINIC_NUMBER });
  const avail = await internal("/tools/check_availability", { callId: start.json.callId, args: {} });
  const b = await internal("/tools/book_appointment", { callId: start.json.callId, args: { startAt: avail.json.slots[1].startAt, firstName: "Sarah" } });
  assert.equal(b.json.ok, true, JSON.stringify(b.json));

  const form = (text: string) =>
    fetch(`${base}/webhooks/plivo/sms`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ From: CALLER.slice(1), To: CLINIC_NUMBER.slice(1), Text: text, MessageUUID: "m1" }),
    });
  assert.equal((await form("C")).status, 200);
  const appt = await db.query.appointments.findFirst({ where: eq(schema.appointments.id, b.json.appointmentId) });
  assert.equal(appt!.status, "CONFIRMED");

  assert.equal((await form("STOP")).status, 200);
  const p = (await db.query.patients.findMany({ where: eq(schema.patients.phone, CALLER) })).find((x) => x.smsOptOut);
  assert.equal(p!.smsOptOut, true);
});

test("jobs run without errors (dry run)", async () => {
  await sendReminders();
  await dispatchOutbound();
  await dailyReports();
  const daily = await call("GET", "/api/reports/daily");
  assert.equal(daily.status, 200);
  assert.equal(typeof daily.json.summary.showed, "number");
});

test("2FA setup and login with code", async () => {
  const setup = await call("POST", "/auth/mfa/setup");
  assert.ok(setup.json.qrDataUrl.startsWith("data:image/png"));
  const en = await call("POST", "/auth/mfa/enable", { code: totpCode(setup.json.secret) });
  assert.equal(en.status, 200, JSON.stringify(en.json));
  const saved = token;
  token = "";
  const l = await call("POST", "/auth/login", { email: OWNER_EMAIL, password: OWNER_PASS });
  assert.equal(l.json.mfaRequired, true);
  const v = await call("POST", "/auth/mfa/verify", { mfaToken: l.json.mfaToken, code: totpCode(setup.json.secret) });
  assert.equal(v.status, 200);
  token = v.json.accessToken;
  // turn it back off for repeatable test runs
  await db.update(schema.users).set({ totpEnabled: false }).where(eq(schema.users.email, OWNER_EMAIL));
  assert.ok(saved);
});

test("audit log records PHI access", async () => {
  const logs = await call("GET", "/api/audit-logs");
  const actions = new Set(logs.json.map((l: any) => l.action));
  for (const a of ["LOGIN", "VIEW_CALL", "AI_BOOKED", "SET_APPOINTMENT_STATUS"]) assert.ok(actions.has(a), `missing ${a}`);
});

test("super admin can create a clinic", async () => {
  const adminEmail = process.env.ADMIN_EMAIL ?? "admin@deificdigital.com";
  const adminPassword = process.env.ADMIN_PASSWORD ?? "ChangeMe-Admin-2026";
  const l = await call("POST", "/auth/login", { email: adminEmail, password: adminPassword });
  token = l.json.accessToken;
  const num = `+1512555${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const r = await call("POST", "/admin/clinics", {
    name: "Test Clinic", aiPhoneNumber: num, timezone: "America/Chicago",
    owner: { name: "T Owner", email: `t${Date.now()}@example.com`, password: "a-long-password-1" },
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const list = await call("GET", "/admin/clinics");
  assert.ok(list.json.some((c: any) => c.aiPhoneNumber === num));
});
