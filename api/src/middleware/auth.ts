import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { forbidden, HttpError } from "../lib/http";
import { safeEqual } from "../lib/crypto";
import { db, schema } from "../db";
import { eq } from "drizzle-orm";

export type Role = "SUPER_ADMIN" | "CLINIC_OWNER" | "CLINIC_STAFF";

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  clinicId: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const JWT_OPTS = { algorithms: ["HS256"] as jwt.Algorithm[], issuer: "dental-ai-api", audience: "dental-ai" };

export function signAccessToken(u: AuthUser & { tokenVersion?: number }): string {
  return jwt.sign(
    { sub: u.id, email: u.email, role: u.role, clinicId: u.clinicId, typ: "access", ver: u.tokenVersion ?? 0 },
    config.jwtSecret,
    { expiresIn: `${config.accessTokenMinutes}m`, algorithm: "HS256", issuer: JWT_OPTS.issuer, audience: JWT_OPTS.audience },
  );
}

// Short cache of {active, tokenVersion, role, clinicId, totpEnabled} so revocation is near-instant without a DB hit per request
const userCache = new Map<string, { at: number; active: boolean; ver: number; role: Role; clinicId: string | null; totp: boolean }>();
export function forgetUser(userId: string) { userCache.delete(userId); }
async function currentUser(id: string) {
  const c = userCache.get(id);
  if (c && Date.now() - c.at < 15_000) return c;
  const u = await db.query.users.findFirst({ where: eq(schema.users.id, id) });
  if (!u) return null;
  const v = { at: Date.now(), active: u.active, ver: u.tokenVersion, role: u.role as Role, clinicId: u.clinicId, totp: u.totpEnabled };
  userCache.set(id, v);
  return v;
}

/** Short-lived token issued after password check, exchanged for real tokens once 2FA passes. */
export function signMfaToken(userId: string): string {
  return jwt.sign({ sub: userId, typ: "mfa" }, config.jwtSecret, { expiresIn: "5m", algorithm: "HS256", issuer: JWT_OPTS.issuer, audience: JWT_OPTS.audience });
}

export function verifyMfaToken(token: string): string {
  let p: jwt.JwtPayload;
  try { p = jwt.verify(token, config.jwtSecret, JWT_OPTS) as jwt.JwtPayload; } catch { throw new HttpError(401, "Invalid MFA token"); }
  if (p.typ !== "mfa" || !p.sub) throw new HttpError(401, "Invalid MFA token");
  return p.sub;
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return next(new HttpError(401, "Not signed in"));
  let p: jwt.JwtPayload;
  try {
    p = jwt.verify(h.slice(7), config.jwtSecret, JWT_OPTS) as jwt.JwtPayload;
    if (p.typ !== "access" || !p.sub) throw new Error("wrong token type");
  } catch {
    return next(new HttpError(401, "Session expired, please sign in again"));
  }
  // Disabled users, password changes, role changes and "sign out everywhere" invalidate tokens at once
  currentUser(p.sub!).then((u) => {
    if (!u || !u.active || u.ver !== (p.ver ?? 0)) return next(new HttpError(401, "Session expired, please sign in again"));
    // Role and clinic come from the database, not only from the token
    req.user = { id: p.sub!, email: p.email, role: u.role, clinicId: u.clinicId ?? null };
    (req as Request & { mfa?: boolean }).mfa = u.totp;
    next();
  }, next);
}

/** Super admins must have two-factor login turned on before using admin routes (production default). */
export function requireAdminMfa(req: Request, _res: Response, next: NextFunction) {
  if (!config.requireAdminMfa) return next();
  if (req.user?.role === "SUPER_ADMIN" && !(req as Request & { mfa?: boolean }).mfa) {
    return next(new HttpError(403, "Turn on two-factor login (Settings → Security) to use admin features."));
  }
  next();
}

export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) return next(forbidden());
    next();
  };

/**
 * Which clinic the request acts on. Clinic users are locked to their own clinic;
 * super admins pick one with ?clinicId= (or the X-Clinic-Id header).
 */
export function clinicScope(req: Request): string {
  const u = req.user!;
  if (u.role === "SUPER_ADMIN") {
    const c = (req.query.clinicId as string) || (req.headers["x-clinic-id"] as string);
    if (!c) throw new HttpError(400, "clinicId is required for super admin");
    return c;
  }
  if (!u.clinicId) throw forbidden("No clinic assigned");
  return u.clinicId;
}

/** Voice agent -> API calls are authenticated with a shared secret. */
export function requireInternalKey(req: Request, _res: Response, next: NextFunction) {
  const key = req.headers["x-internal-key"];
  if (typeof key !== "string" || !safeEqual(key, config.internalApiKey)) {
    return next(new HttpError(401, "Invalid internal key"));
  }
  if (config.internalAllowedIps.length) {
    const ip = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    if (!config.internalAllowedIps.includes(ip)) return next(new HttpError(403, "Internal API not allowed from this address"));
  }
  next();
}
