import bcrypt from "bcryptjs";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { and, eq, gt, isNull } from "drizzle-orm";
import QRCode from "qrcode";
import { z } from "zod";
import { config } from "../config";
import { db, schema } from "../db";
import type { User } from "../db/schema";
import { audit } from "../lib/audit";
import { decrypt, encrypt, generateTotpSecret, randomToken, sha256, totpUri, verifyTotp } from "../lib/crypto";
import { ah, badRequest, HttpError } from "../lib/http";
import { requireAuth, signAccessToken, signMfaToken, verifyMfaToken } from "../middleware/auth";

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
    accessToken: signAccessToken({ id: user.id, email: user.email, role: user.role, clinicId: user.clinicId }),
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
    const { email, password } = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const user = await db.query.users.findFirst({ where: eq(schema.users.email, email.toLowerCase()) });
    const ok = user && user.active && (await bcrypt.compare(password, user.passwordHash));
    if (!ok) {
      await audit(req, { action: "LOGIN_FAILED", meta: { email } }, email);
      throw new HttpError(401, "Wrong email or password");
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
    const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
    const session = await db.query.sessions.findFirst({
      where: and(
        eq(schema.sessions.refreshHash, sha256(refreshToken)),
        isNull(schema.sessions.revokedAt),
        gt(schema.sessions.expiresAt, new Date()),
      ),
    });
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
    res.json({ user: publicUser(user), clinic: clinic ? { id: clinic.id, name: clinic.name, timezone: clinic.timezone } : null });
  }),
);

/** Step 1 of turning on 2FA: get a secret + QR code for Google Authenticator / Authy. */
authRouter.post(
  "/mfa/setup",
  requireAuth,
  ah(async (req, res) => {
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
    await audit(req, { action: "MFA_ENABLED" });
    res.json({ ok: true });
  }),
);

authRouter.post(
  "/change-password",
  requireAuth,
  ah(async (req, res) => {
    const { currentPassword, newPassword } = z
      .object({ currentPassword: z.string(), newPassword: z.string().min(10) })
      .parse(req.body);
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, req.user!.id) });
    if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) throw badRequest("Current password is wrong");
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash(newPassword, 12) }).where(eq(schema.users.id, user.id));
    // Sign out other devices
    await db.update(schema.sessions).set({ revokedAt: new Date() }).where(eq(schema.sessions.userId, user.id));
    await audit(req, { action: "PASSWORD_CHANGED" });
    res.json({ ok: true });
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
