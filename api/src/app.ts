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
import { webhookRouter } from "./routes/webhooks";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false })); // Plivo webhooks are form-encoded

  // Webhooks + internal: server-to-server, no CORS
  app.use("/webhooks", webhookRouter);
  app.use("/internal", internalRouter);

  const browser = cors({ origin: config.corsOrigins, credentials: false });
  app.use("/auth", browser, authRouter);
  app.use("/api/crm", browser, crmRouter);
  app.use("/api", browser, clinicRouter);
  app.use("/admin", browser, adminRouter);

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}
