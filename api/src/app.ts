import cors from "cors";
import express from "express";
import helmet from "helmet";
import { config } from "./config";
import { errorHandler } from "./lib/http";
import { adminRouter } from "./routes/admin";
import { authRouter } from "./routes/auth";
import { clinicRouter } from "./routes/clinic";
import { crmRouter } from "./routes/crm";
import { internalRouter } from "./routes/internal";
import { patientRouter } from "./routes/patient";
import { webhookRouter } from "./routes/webhooks";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false })); // Plivo webhooks are form-encoded

  // Webhooks + internal: server-to-server
  app.use("/webhooks", webhookRouter);
  app.use("/internal", internalRouter);
  // Public secure-link pages for patients (no login; token + check question)
  app.use("/p", patientRouter);

  const isWildcard = config.corsOrigins.includes("*");
  const browser = cors({
    origin: isWildcard ? true : config.corsOrigins,
    credentials: true,
  });
  app.use(browser);

  app.use("/auth", authRouter);
  app.use("/api/crm", crmRouter);
  app.use("/api", clinicRouter);
  app.use("/admin", adminRouter);

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/", (_req, res) => res.json({
    name: "Dental AI Receptionist API",
    status: "online",
    health: "/health",
    version: "1.0.0"
  }));
  app.use(errorHandler);
  return app;
}
