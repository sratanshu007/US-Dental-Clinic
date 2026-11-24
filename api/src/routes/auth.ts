import bcrypt from "bcryptjs";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import QRCode from "qrcode";
import { z } from "zod";
import { config } from "../config";
import { db, schema } from "../db";
import type { User } from "../db/schema";
import { audit } from "../lib/audit";
import { decrypt, encrypt, generateTotpSecret, randomToken, sha256, totpUri, verifyTotp } from "../lib/crypto";
import { ah, badRequest, HttpError } from "../lib/http";
import { forgetUser, requireAuth, signAccessToken, signMfaToken, verifyMfaToken } from "../middleware/auth";
import { newPassword as newPasswordField, passwordProblem } from "../lib/password";
import { alert } from "../lib/alerts";
import { planView } from "../middleware/plan";

// Compared against when the email doesn't exist, so response time doesn't reveal which emails are registered
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing-only", 12);

/** Invalidate every access + refresh token of a user (password change, disable, theft detected). */
export async function revokeAllSessions(userId: string) {
  await db.update(schema.users).set({ tokenVersion: sql`${schema.users.tokenVersion} + 1` }).where(eq(schema.users.id, userId));
  await db.update(schema.sessions).set({ revokedAt: new Date() }).where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)));
  forgetUser(userId);
}

export const authRouter = Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

async function issueTokens(user: User, ip?: string, userAgent?: string) {
  const refreshToken = randomToken();
  await db.insert(schema.sessions).values({
    userId: user.id,
    refreshHash: sha256(refreshToken),
    expiresAt: new Date(Date.now() + config.refreshTokenDays * 86400_000),
    ip,
    userAgent,
  });
  await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));
  return {
    accessToken: signAccessToken({ id: user.id, email: user.email, role: user.role, clinicId: user.clinicId, tokenVersion: user.tokenVersion }),
    refreshToken,
    expiresInSec: config.accessTokenMinutes * 60,
    user: publicUser(user),
  };
}

export const publicUser = (u: User) => ({
  id: u.id, email: u.email, name: u.name, role: u.role, clinicId: u.clinicId, totpEnabled: u.totpEnabled,
});

authRouter.post(
  "/login",
  loginLimiter,
  ah(async (req, res) => {
    const { email, password } = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }).parse(req.body);
    const user = await db.query.users.findFirst({ where: eq(schema.users.email, email.toLowerCase()) });
    // Locked accounts: same message and same timing as a wrong password
    const locked = !!user?.lockedUntil && user.lockedUntil > new Date();
    const match = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    const ok = !!user && user.active && !locked && match;
    if (!ok) {
      if (user && !locked) {
        const fails = user.failedLogins + 1;
        const lock = fails >= config.maxFailedLogins;
        await db.update(schema.users).set({
          failedLogins: lock ? 0 : fails,
          ...(lock ? { lockedUntil: new Date(Date.now() + config.lockoutMinutes * 60_000) } : {}),
        }).where(eq(schema.users.id, user.id));
        if (lock) {
          await audit(req, { action: "ACCOUNT_LOCKED", entity: "user", entityId: user.id, clinicId: user.clinicId }, user.email);
          void alert(`lock:${user.id}`, `Account locked after ${config.maxFailedLogins} wrong passwords (user ${user.id}, role ${user.role}).`);
        }
      }
      await audit(req, { action: "LOGIN_FAILED", meta: { locked } }, email);
      throw new HttpError(401, locked ? "Too many attempts. Try again later or reset your password." : "Wrong email or password");
    }
    if (user.failedLogins || user.lockedUntil) {
      await db.update(schema.users).set({ failedLogins: 0, lockedUntil: null }).where(eq(schema.users.id, user.id));
    }
    if (user.totpEnabled) {
      return res.json({ mfaRequired: true, mfaToken: signMfaToken(user.id) });
    }
    await audit(req, { action: "LOGIN", clinicId: user.clinicId }, user.email);
    res.json(await issueTokens(user, req.ip, req.headers["user-agent"]));
  }),
);

authRouter.post(
  "/mfa/verify",
  loginLimiter,
  ah(async (req, res) => {
    const { mfaToken, code } = z.object({ mfaToken: z.string(), code: z.string() }).parse(req.body);
    const userId = verifyMfaToken(mfaToken);
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
    if (!user?.active || (user.lockedUntil && user.lockedUntil > new Date())) throw new HttpError(401, "Wrong code");
    if (!user?.totpSecretEnc || !verifyTotp(decrypt(user.totpSecretEnc)!, code)) {
      await audit(req, { action: "MFA_FAILED", clinicId: user?.clinicId }, user?.email);
      throw new HttpError(401, "Wrong code");
    }
    await audit(req, { action: "LOGIN", clinicId: user.clinicId, meta: { mfa: true } }, user.email);
    res.json(await issueTokens(user, req.ip, req.headers["user-agent"]));
  }),
);

authRouter.post(
  "/refresh",
  ah(async (req, res) => {
    const { refreshToken } = z.object({ refreshToken: z.string().max(200) }).parse(req.body);
    const any = await db.query.sessions.findFirst({ where: eq(schema.sessions.refreshHash, sha256(refreshToken)) });
    if (any?.revokedAt) {
      // A refresh token that was already rotated is being used again: it was copied. Sign this user out everywhere.
      const recent = Date.now() - any.revokedAt.getTime() < 10_000; // two tabs refreshing at once is not theft
      if (!recent) {
        await revokeAllSessions(any.userId);
        await audit(req, { action: "REFRESH_TOKEN_REUSE", entity: "user", entityId: any.userId }, "system");
        void alert(`reuse:${any.userId}`, `Reused refresh token detected — user ${any.userId} signed out everywhere.`);
      }
      throw new HttpError(401, "Session expired");
    }
    const session = any && !any.revokedAt && any.expiresAt > new Date() ? any : null;
    if (!session) throw new HttpError(401, "Session expired");
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, session.userId) });
    if (!user?.active) throw new HttpError(401, "Account disabled");
    // Rotate: old refresh token can't be reused
    await db.update(schema.sessions).set({ revokedAt: new Date() }).where(eq(schema.sessions.id, session.id));
    res.json(await issueTokens(user, req.ip, req.headers["user-agent"]));
  }),
);

authRouter.post(
  "/logout",
  ah(async (req, res) => {
    const { refreshToken } = z.object({ refreshToken: z.string().optional() }).parse(req.body ?? {});
    if (refreshToken) {
      await db.update(schema.sessions).set({ revokedAt: new Date() }).where(eq(schema.sessions.refreshHash, sha256(refreshToken)));
    }
    res.json({ ok: true });
  }),
);

authRouter.get(
  "/me",
  requireAuth,
  ah(async (req, res) => {
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, req.user!.id) });
    if (!user) throw new HttpError(401, "User not found");
    const clinic = user.clinicId
      ? await db.query.clinics.findFirst({ where: eq(schema.clinics.id, user.clinicId) })
      : null;
    res.json({ user: publicUser(user), clinic: clinic ? { id: clinic.id, name: clinic.name, timezone: clinic.timezone, plan: planView(clinic) } : null });
  }),
);

/** Step 1 of turning on 2FA: get a secret + QR code for Google Authenticator / Authy. */
authRouter.post(
  "/mfa/setup",
  requireAuth,
  ah(async (req, res) => {
    // Re-authenticate: a stolen session must not be able to replace or switch off 2FA
    const { password } = z.object({ password: z.string().min(1).max(200) }).parse(req.body ?? {});
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, req.user!.id) });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) throw badRequest("Password is wrong");
    if (user.totpEnabled) throw badRequest("Two-factor login is already on. Turn it off first (needs your password and a code).");
    const secret = generateTotpSecret();
    await db.update(schema.users).set({ totpSecretEnc: encrypt(secret), totpEnabled: false }).where(eq(schema.users.id, req.user!.id));
    const uri = totpUri(secret, req.user!.email);
    res.json({ secret, otpauthUrl: uri, qrDataUrl: await QRCode.toDataURL(uri) });
  }),
);

/** Step 2: confirm with a code from the app. */
authRouter.post(
  "/mfa/enable",
  requireAuth,
  ah(async (req, res) => {
    const { code } = z.object({ code: z.string() }).parse(req.body);
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, req.user!.id) });
    if (!user?.totpSecretEnc) throw badRequest("Run setup first");
    if (!verifyTotp(decrypt(user.totpSecretEnc)!, code)) throw badRequest("Wrong code");
    await db.update(schema.users).set({ totpEnabled: true }).where(eq(schema.users.id, user.id));
    forgetUser(user.id);
    await audit(req, { action: "MFA_ENABLED" });
    res.json({ ok: true });
  }),
);

/** Turn 2FA off: needs the password AND a current code. */
authRouter.post(
  "/mfa/disable",
  requireAuth,
  loginLimiter,
  ah(async (req, res) => {
    const { password, code } = z.object({ password: z.string().min(1).max(200), code: z.string().max(10) }).parse(req.body);
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, req.user!.id) });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) throw badRequest("Password is wrong");
    if (!user.totpEnabled || !user.totpSecretEnc || !verifyTotp(decrypt(user.totpSecretEnc)!, code)) throw badRequest("Wrong code");
    await db.update(schema.users).set({ totpEnabled: false, totpSecretEnc: null }).where(eq(schema.users.id, user.id));
    await revokeAllSessions(user.id);
    await audit(req, { action: "MFA_DISABLED" });
    void alert(`mfaoff:${user.id}`, `Two-factor login turned off for user ${user.id} (${user.role}).`, 1);
    res.json({ ok: true });
  }),
);

/** Sign out on every device. */
authRouter.post(
  "/logout-all",
  requireAuth,
  ah(async (req, res) => {
    await revokeAllSessions(req.user!.id);
    await audit(req, { action: "LOGOUT_ALL" });
    res.json({ ok: true });
  }),
);

authRouter.post(
  "/change-password",
  requireAuth,
  ah(async (req, res) => {
    const { currentPassword, newPassword } = z
      .object({ currentPassword: z.string().max(200), newPassword: newPasswordField })
      .parse(req.body);
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, req.user!.id) });
    if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) throw badRequest("Current password is wrong");
    const problem = passwordProblem(newPassword, { email: user.email, name: user.name });
    if (problem) throw badRequest(problem);
    if (await bcrypt.compare(newPassword, user.passwordHash)) throw badRequest("Choose a password you haven't used here");
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash(newPassword, 12), passwordChangedAt: new Date() }).where(eq(schema.users.id, user.id));
    // Sign out every device (this one gets a fresh session below)
    await revokeAllSessions(user.id);
    await audit(req, { action: "PASSWORD_CHANGED" });
    const fresh = await db.query.users.findFirst({ where: eq(schema.users.id, user.id) });
    res.json({ ok: true, ...(await issueTokens(fresh!, req.ip, req.headers["user-agent"])) });
  }),
);

authRouter.post(
  "/push-token",
  requireAuth,
  ah(async (req, res) => {
    const { token, platform } = z.object({ token: z.string().min(10), platform: z.string().optional() }).parse(req.body);
    await db
      .insert(schema.pushTokens)
      .values({ userId: req.user!.id, token, platform })
      .onConflictDoUpdate({ target: schema.pushTokens.token, set: { userId: req.user!.id, platform } });
    res.json({ ok: true });
  }),
);
