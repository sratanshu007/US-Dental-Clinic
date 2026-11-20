import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { forbidden, HttpError } from "../lib/http";
import { safeEqual } from "../lib/crypto";

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

export function signAccessToken(u: AuthUser): string {
  return jwt.sign({ sub: u.id, email: u.email, role: u.role, clinicId: u.clinicId, typ: "access" }, config.jwtSecret, {
    expiresIn: `${config.accessTokenMinutes}m`,
  });
}

/** Short-lived token issued after password check, exchanged for real tokens once 2FA passes. */
export function signMfaToken(userId: string): string {
  return jwt.sign({ sub: userId, typ: "mfa" }, config.jwtSecret, { expiresIn: "5m" });
}

export function verifyMfaToken(token: string): string {
  const p = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
  if (p.typ !== "mfa" || !p.sub) throw new HttpError(401, "Invalid MFA token");
  return p.sub;
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return next(new HttpError(401, "Not signed in"));
  try {
    const p = jwt.verify(h.slice(7), config.jwtSecret) as jwt.JwtPayload;
    if (p.typ !== "access") throw new Error("wrong token type");
    req.user = { id: p.sub!, email: p.email, role: p.role, clinicId: p.clinicId ?? null };
    next();
  } catch {
    next(new HttpError(401, "Session expired, please sign in again"));
  }
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
  next();
}
