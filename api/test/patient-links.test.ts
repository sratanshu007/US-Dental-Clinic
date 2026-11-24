// Secure SMS links (LINK mode): texts carry no appointment details; the page asks a check question first.
// Run: JOBS_ENABLED=false npm test
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { and, desc, eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { createApp } from "../src/app";
import { db, pool, schema } from "../src/db";
import type { Appointment, Clinic, Patient } from "../src/db/schema";
import { decrypt } from "../src/lib/crypto";
import { sendReminders } from "../src/jobs";
import { DEFAULT_HOURS } from "../src/routes/admin";
import { createPatientLink } from "../src/services/patientLinks";
import { reminderText } from "../src/services/smsText";

let server: Server;
let base = "";
let clinic: Clinic;
let patient: Patient;
let appt: Appointment;
const NUM = `+1830557${String(Math.floor(Math.random() * 9000) + 1000)}`;
const PHONE = `+1210557${String(Math.floor(Math.random() * 9000) + 1000)}`;

const tokenOf = (url: string) => url.split("/p/")[1];
async function req(method: string, path: string, body?: unknown, session?: string) {
  const r = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Bearer ${session}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, json, headers: r.headers };
}

before(async () => {
  [clinic] = await db.insert(schema.clinics).values({
    name: "Link Test Dental", aiPhoneNumber: NUM, timezone: "America/Chicago", businessHours: DEFAULT_HOURS, reminderHoursBefore: 48,
  }).returning();
  const [prov] = await db.insert(schema.providers).values({ clinicId: clinic.id, name: "Dr. Lee" }).returning();
  const [svc] = await db.insert(schema.services).values({ clinicId: clinic.id, name: "Cleaning", durationMin: 45 }).returning();
  [patient] = await db.insert(schema.patients).values({
    clinicId: clinic.id, phone: PHONE, firstName: "Ana", lastName: "Rivera", smsConsent: true,
  }).returning();
  const start = DateTime.now().plus({ hours: 26 }).startOf("hour");
  [appt] = await db.insert(schema.appointments).values({
    clinicId: clinic.id, patientId: patient.id, providerId: prov.id, serviceId: svc.id,
    startAt: start.toJSDate(), endAt: start.plus({ minutes: 45 }).toJSDate(), status: "BOOKED",
  }).returning();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  await pool.end();
});

test("LINK mode: new clinics default to LINK and the reminder text has no day/time", async () => {
  assert.equal(clinic.smsStyle, "LINK");
  const text = await reminderText(clinic, patient, appt);
  assert.match(text, /^Link Test Dental: you have an upcoming appointment\. View details: http\S+\/p\/[A-Za-z0-9_-]{24} Reply C/);
  assert.doesNotMatch(text, /AM|PM|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/);
});

test("FULL mode still puts the day and time in the text", async () => {
  const text = await reminderText({ ...clinic, smsStyle: "FULL" }, patient, appt);
  assert.match(text, /reminder: your appointment is \w+day, .* (AM|PM)\./);
});

test("reminder job sends a link text and stores only the token hash", async () => {
  await sendReminders();
  const sms = await db.query.smsMessages.findFirst({
    where: and(eq(schema.smsMessages.patientId, patient.id), eq(schema.smsMessages.purpose, "REMINDER")),
    orderBy: desc(schema.smsMessages.createdAt),
  });
  assert.ok(sms, "reminder was not sent");
  const body = decrypt(sms!.bodyEnc)!;
  assert.match(body, /\/p\/[A-Za-z0-9_-]{24}/);
  assert.match(body, /Reply STOP to opt out\.$/);
  const token = body.match(/\/p\/([A-Za-z0-9_-]{24})/)![1];
  const rows = await db.select().from(schema.patientLinks).where(eq(schema.patientLinks.patientId, patient.id));
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => !r.tokenHash.includes(token)), "raw token must never be stored");
});

test("page and info reveal no appointment details; headers are private", async () => {
  const url = await createPatientLink(clinic, patient, appt, "REMINDER");
  const page = await req("GET", `/p/${tokenOf(url)}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(page.headers.get("x-robots-tag") ?? "", /noindex/);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.doesNotMatch(String(page.json), /Rivera|Ana|Cleaning|Dr\. Lee/);

  const info = await req("GET", `/p/${tokenOf(url)}/info`);
  assert.equal(info.status, 200);
  assert.deepEqual(info.json.question, { kind: "last_name", label: "Your last name" });
  assert.doesNotMatch(JSON.stringify(info.json), /Rivera|Ana|Cleaning|Lee/);

  const bad = await req("GET", "/p/not-a-real-token-123456/info");
  assert.equal(bad.status, 404);
});

test("check question -> details -> confirm -> ask for a new time", async () => {
  const t = tokenOf(await createPatientLink(clinic, patient, appt, "REMINDER"));
  const noSession = await req("GET", `/p/${t}/details`);
  assert.equal(noSession.status, 401);

  const wrong = await req("POST", `/p/${t}/verify`, { answer: "Smith" });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.attemptsLeft, 4);

  const ok = await req("POST", `/p/${t}/verify`, { answer: "  rivera " }); // case and spaces don't matter
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const s = ok.json.session as string;
  assert.equal(ok.json.details.appointment.service, "Cleaning");
  assert.equal(ok.json.details.appointment.provider, "Dr. Lee");
  assert.equal(ok.json.details.appointment.canConfirm, true);

  const conf = await req("POST", `/p/${t}/confirm`, {}, s);
  assert.equal(conf.status, 200, JSON.stringify(conf.json));
  assert.equal(conf.json.appointment.status, "CONFIRMED");
  const fresh = await db.query.appointments.findFirst({ where: eq(schema.appointments.id, appt.id) });
  assert.equal(fresh!.status, "CONFIRMED");

  const again = await req("POST", `/p/${t}/confirm`, {}, s);
  assert.equal(again.status, 409);

  const rs = await req("POST", `/p/${t}/reschedule`, {}, s);
  assert.equal(rs.status, 200, JSON.stringify(rs.json));
  const task = await db.query.crmTasks.findFirst({ where: eq(schema.crmTasks.clinicId, clinic.id), orderBy: desc(schema.crmTasks.createdAt) });
  assert.match(task!.title, /Reschedule request \(secure link\)/);

  const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.clinicId, clinic.id));
  const actions = new Set(audits.map((a) => a.action));
  for (const a of ["patient_link.open", "patient_link.verify_failed", "patient_link.verified", "patient_link.confirm", "patient_link.reschedule_request"]) {
    assert.ok(actions.has(a), `missing audit ${a}`);
  }
});

test("5 wrong answers lock the link", async () => {
  const t = tokenOf(await createPatientLink(clinic, patient, appt, "REMINDER"));
  for (let i = 0; i < 4; i++) assert.equal((await req("POST", `/p/${t}/verify`, { answer: "nope" })).status, 400);
  assert.equal((await req("POST", `/p/${t}/verify`, { answer: "nope" })).status, 423);
  assert.equal((await req("POST", `/p/${t}/verify`, { answer: "Rivera" })).status, 423, "right answer must not unlock");
  assert.equal((await req("GET", `/p/${t}/info`)).json.state, "locked");
});

test("expired links stop working", async () => {
  const t = tokenOf(await createPatientLink(clinic, patient, appt, "REMINDER"));
  const { sha256 } = await import("../src/lib/crypto");
  await db.update(schema.patientLinks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.patientLinks.tokenHash, sha256(t)));
  assert.equal((await req("GET", `/p/${t}/info`)).json.state, "expired");
  assert.equal((await req("POST", `/p/${t}/verify`, { answer: "Rivera" })).status, 410);
});

test("patient without a last name gets the first-name question", async () => {
  const [p2] = await db.insert(schema.patients).values({ clinicId: clinic.id, phone: `+1210554${String(Math.floor(Math.random() * 9000) + 1000)}`, firstName: "Sam", smsConsent: true }).returning();
  const t = tokenOf(await createPatientLink(clinic, p2, null, "BOOKED"));
  assert.equal((await req("GET", `/p/${t}/info`)).json.question.kind, "first_name");
  const ok = await req("POST", `/p/${t}/verify`, { answer: "sam" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.details.appointment, null);
});
