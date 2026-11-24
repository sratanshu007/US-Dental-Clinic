// Security controls: lockout, instant token revocation, refresh-token theft detection, password policy,
// 2FA re-authentication, admin 2FA requirement, production config guard, internal key, headers.
import "./_env";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { db, pool, schema } from "../src/db";
import { DEFAULT_HOURS } from "../src/routes/admin";
import { passwordProblem } from "../src/lib/password";
import { securityProblems } from "../src/lib/securityCheck";

let server: Server;
let base = "";
const rnd = () => String(Math.floor(Math.random() * 90000) + 10000);
const EMAIL = `sec-${Date.now()}@test.local`;
const PASS = "Very-Long-Test-Passphrase-42";
let clinicId = "";
let userId = "";

async function call(method: string, path: string, body?: unknown, token?: string, ip?: string) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(ip ? { "X-Forwarded-For": ip } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : null, headers: r.headers };
}
const login = (email = EMAIL, password = PASS, ip?: string) => call("POST", "/auth/login", { email, password }, undefined, ip ?? `10.9.${rnd().slice(0, 2)}.${rnd().slice(0, 2)}`);

before(async () => {
  const [c] = await db.insert(schema.clinics).values({ name: "Sec Dental", aiPhoneNumber: `+1830570${rnd().slice(0, 4)}`, businessHours: DEFAULT_HOURS }).returning();
  clinicId = c.id;
  const [u] = await db.insert(schema.users).values({ clinicId, email: EMAIL, name: "Sec Owner", role: "CLINIC_OWNER", passwordHash: await bcrypt.hash(PASS, 10) }).returning();
  userId = u.id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { server.close(); await pool.end(); });

test("security headers on every response", async () => {
  const r = await fetch(`${base}/health`);
  assert.match(r.headers.get("strict-transport-security") ?? "", /max-age=63072000/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("x-powered-by"), null);
});

test("tokens: forged algorithm / wrong secret / missing claims are rejected", async () => {
  const none = jwt.sign({ sub: userId, typ: "access", role: "SUPER_ADMIN" }, "", { algorithm: "none" as any });
  assert.equal((await call("GET", "/auth/me", undefined, none)).status, 401);
  const wrong = jwt.sign({ sub: userId, typ: "access", role: "SUPER_ADMIN" }, "not-the-secret", { issuer: "dental-ai-api", audience: "dental-ai" });
  assert.equal((await call("GET", "/auth/me", undefined, wrong)).status, 401);
  const noAud = jwt.sign({ sub: userId, typ: "access", role: "CLINIC_OWNER", clinicId }, config.jwtSecret);
  assert.equal((await call("GET", "/auth/me", undefined, noAud)).status, 401, "issuer/audience are required");
});

test("role in the token can't be escalated: role comes from the database", async () => {
  const l = await login();
  const { iat: _i, exp: _e, iss: _s, aud: _a, ...payload } = jwt.decode(l.json.accessToken) as any;
  // Even signed with the real secret, a role claim of SUPER_ADMIN doesn't grant admin
  const forged = jwt.sign({ ...payload, role: "SUPER_ADMIN" }, config.jwtSecret, { issuer: "dental-ai-api", audience: "dental-ai", expiresIn: "5m" });
  assert.equal((await call("GET", "/admin/clinics", undefined, forged)).status, 403);
});

test("account locks after 5 wrong passwords, with the same message and no enumeration", async () => {
  const ghost = await login(`nobody-${rnd()}@test.local`, "whatever-wrong-1");
  const wrong = await login(EMAIL, "wrong-password-xx");
  assert.equal(ghost.status, 401);
  assert.equal(ghost.json.error, wrong.json.error, "unknown email and wrong password look the same");
  for (let i = 0; i < 4; i++) await login(EMAIL, "wrong-password-xx");
  const locked = await login(EMAIL, PASS);
  assert.equal(locked.status, 401, "right password is refused while locked");
  const u = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  assert.ok(u!.lockedUntil && u!.lockedUntil > new Date());
  await db.update(schema.users).set({ lockedUntil: null, failedLogins: 0 }).where(eq(schema.users.id, userId));
  assert.equal((await login()).status, 200);
});

test("disabling a user or changing the password kills existing tokens at once", async () => {
  const l = await login();
  assert.equal((await call("GET", "/auth/me", undefined, l.json.accessToken)).status, 200);
  const ch = await call("POST", "/auth/change-password", { currentPassword: PASS, newPassword: "short" }, l.json.accessToken);
  assert.equal(ch.status, 400, "weak new password refused");
  const NEW = "Another-Long-Passphrase-77";
  const ok = await call("POST", "/auth/change-password", { currentPassword: PASS, newPassword: NEW }, l.json.accessToken);
  assert.equal(ok.status, 200);
  assert.equal((await call("GET", "/auth/me", undefined, l.json.accessToken)).status, 401, "old access token is dead");
  assert.equal((await call("POST", "/auth/refresh", { refreshToken: l.json.refreshToken })).status, 401, "old refresh token is dead");
  assert.equal((await call("GET", "/auth/me", undefined, ok.json.accessToken)).status, 200, "the new session works");
  await db.update(schema.users).set({ passwordHash: await bcrypt.hash(PASS, 10) }).where(eq(schema.users.id, userId));
});

test("reusing a rotated refresh token signs the user out everywhere", async () => {
  const l = await login();
  const r1 = await call("POST", "/auth/refresh", { refreshToken: l.json.refreshToken });
  assert.equal(r1.status, 200);
  // Pretend the rotation happened a while ago (beyond the 10 s two-tabs grace)
  await db.update(schema.sessions).set({ revokedAt: new Date(Date.now() - 60_000) }).where(eq(schema.sessions.userId, userId));
  const thief = await call("POST", "/auth/refresh", { refreshToken: l.json.refreshToken });
  assert.equal(thief.status, 401);
  assert.equal((await call("GET", "/auth/me", undefined, r1.json.accessToken)).status, 401, "legit session also revoked after theft detected");
});

test("2FA can't be replaced or switched off with just a stolen session", async () => {
  const l = await login();
  assert.equal((await call("POST", "/auth/mfa/setup", {}, l.json.accessToken)).status, 400);
  assert.equal((await call("POST", "/auth/mfa/setup", { password: "wrong" }, l.json.accessToken)).status, 400);
  assert.equal((await call("POST", "/auth/mfa/disable", { password: PASS, code: "000000" }, l.json.accessToken)).status, 400);
});

test("password policy", () => {
  assert.ok(passwordProblem("short"));
  assert.ok(passwordProblem("password1234"));
  assert.ok(passwordProblem("aaaaaaaaaaaaaaa"));
  assert.ok(passwordProblem("drsmithclinic2026", { email: "drsmith@x.com" }));
  assert.equal(passwordProblem("Blue-Tiger-Rides-At-Noon"), null);
});

test("production config guard catches unsafe settings", () => {
  const p = securityProblems({ VERIFY_PLIVO_SIGNATURE: "false" } as any);
  assert.ok(p.some((x) => /VERIFY_PLIVO_SIGNATURE/.test(x)));
  assert.ok(p.some((x) => /CORS_ORIGINS/.test(x)), "localhost CORS is flagged");
});

test("internal API needs the key", async () => {
  const r = await fetch(`${base}/internal/calls/start`, { method: "POST", headers: { "Content-Type": "application/json", "X-Internal-Key": "nope" }, body: "{}" });
  assert.equal(r.status, 401);
});

test("clinic users can't read another clinic's data", async () => {
  const l = await login();
  const [other] = await db.insert(schema.clinics).values({ name: "Other", aiPhoneNumber: `+1830571${rnd().slice(0, 4)}`, businessHours: DEFAULT_HOURS }).returning();
  const [p] = await db.insert(schema.patients).values({ clinicId: other.id, phone: `+1210571${rnd().slice(0, 4)}`, firstName: "Secret" }).returning();
  const r = await call("GET", `/api/patients/${p.id}?clinicId=${other.id}`, undefined, l.json.accessToken);
  assert.ok([403, 404].includes(r.status), `got ${r.status}`);
});

test("plans: Starter gets an upgrade prompt for the CRM; Growth gets it", async () => {
  await db.update(schema.clinics).set({ plan: "STARTER" }).where(eq(schema.clinics.id, clinicId));
  const l = await login();
  const crm = await call("GET", "/api/crm/summary", undefined, l.json.accessToken);
  assert.equal(crm.status, 403);
  assert.equal(crm.json.details.code, "PLAN_UPGRADE");
  const dash = await call("GET", "/api/dashboard", undefined, l.json.accessToken);
  assert.equal(dash.json.plan.name, "Starter");
  assert.equal(dash.json.plan.features.crm, false);
  assert.equal(dash.json.plan.limits.minutes, 1000);
  await db.update(schema.clinics).set({ plan: "GROWTH" }).where(eq(schema.clinics.id, clinicId));
  const ok = await call("GET", "/api/crm/summary", undefined, l.json.accessToken);
  assert.equal(ok.status, 200);
});
