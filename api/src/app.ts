import cors from "cors";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { config } from "./config";
import { errorHandler } from "./lib/http";
import { adminRouter } from "./routes/admin";
import { authRouter } from "./routes/auth";
import { clinicRouter } from "./routes/clinic";
import { crmRouter } from "./routes/crm";
import { internalRouter } from "./routes/internal";
import { patientRouter } from "./routes/patient";
import { webhookRouter } from "./routes/webhooks";
import { integrationsRouter } from "./routes/integrations";
import { pool } from "./db";
import { handleStripeEvent, stripe } from "./services/billing";
import { alert } from "./lib/alerts";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(helmet({
    strictTransportSecurity: { maxAge: 63072000, includeSubDomains: true, preload: true },
    crossOriginResourcePolicy: { policy: "same-site" },
    referrerPolicy: { policy: "no-referrer" },
  }));
  // Nothing from this API should be cached by browsers or proxies (patient data)
  app.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

  // Stripe needs the raw body to verify the signature, so this route comes before the JSON parser.
  app.post("/webhooks/stripe", express.raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
    if (!config.stripe.webhookSecret) return res.status(503).json({ error: "Stripe webhook not configured" });
    let event;
    try {
      event = stripe().webhooks.constructEvent(req.body as Buffer, String(req.headers["stripe-signature"] ?? ""), config.stripe.webhookSecret);
    } catch {
      return res.status(400).json({ error: "Invalid signature" });
    }
    try {
      await handleStripeEvent(event);
      res.json({ received: true });
    } catch (e) {
      await alert("stripe-webhook", `Stripe webhook ${event.type} failed: ${(e as Error).message}`);
      res.status(500).json({ error: "Webhook handler failed" }); // Stripe retries
    }
  });

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false })); // Plivo webhooks are form-encoded

  // Webhooks + internal: server-to-server, no CORS
  app.use("/webhooks", webhookRouter);
  app.use("/internal", internalRouter);
  // Public secure-link pages for patients (no login; token + check question)
  app.use("/p", patientRouter);

  const browser = cors({ origin: config.corsOrigins, credentials: false, maxAge: 600 });
  // Broad per-IP limit for the dashboard/app API (login has its own, stricter limit)
  const apiLimiter = rateLimit({ windowMs: 60_000, limit: Number(process.env.API_RATE_LIMIT ?? 600), standardHeaders: true, legacyHeaders: false });
  app.use(["/api", "/admin", "/auth"], apiLimiter);
  app.use("/auth", browser, authRouter);
  app.use("/api/crm", browser, crmRouter);
  app.use("/api/integrations", browser, integrationsRouter);
  app.use("/api", browser, clinicRouter);
  app.use("/admin", browser, adminRouter);

  // Liveness: the process is up. Readiness: the database answers too (point uptime monitors here).
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/ready", async (_req, res) => {
    const started = Date.now();
    try {
      await pool.query("select 1");
      res.json({ ok: true, db: "ok", dbMs: Date.now() - started });
    } catch {
      res.status(503).json({ ok: false, db: "down" });
    }
  });
  app.use(errorHandler);
  return app;
}
