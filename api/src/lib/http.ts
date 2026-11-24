import type { NextFunction, Request, Response } from "express";
import { ZodError, type ZodTypeAny, type z } from "zod";

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export const notFound = (what = "Not found") => new HttpError(404, what);
export const forbidden = (what = "Forbidden") => new HttpError(403, what);
export const badRequest = (what: string, details?: unknown) => new HttpError(400, what, details);

/** Wrap async route handlers so thrown errors reach the error middleware. */
export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };

export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data);
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: "Invalid request", details: err.issues });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  // Never echo internals (could contain PHI) back to the client.
  const msg = err instanceof Error ? err.message : String(err);
  console.error("[api] unhandled error:", msg);
  void import("./alerts").then(({ alert, scrub }) => alert(`500:${_req.method}:${_req.route?.path ?? _req.path}`, `500 on ${_req.method} ${_req.baseUrl}${_req.route?.path ?? ""}: ${scrub(msg)}`));
  return res.status(500).json({ error: "Internal server error" });
}
