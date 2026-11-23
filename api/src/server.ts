import { createApp } from "./app";
import { config } from "./config";
import { db } from "./db";
import { startJobs } from "./jobs";
import { syncPlivoNumber } from "./services/sms";

const app = createApp();
app.listen(config.port, "0.0.0.0", () => {
  console.log(`[api] listening on :${config.port} (${config.env})${config.dryRun ? " — DRY RUN: SMS/calls are not sent" : ""}`);
  if (config.jobsEnabled) startJobs();

  if (!config.dryRun && config.plivo.authId && config.plivo.authToken) {
    db.query.clinics.findMany().then(async (clinics) => {
      for (const c of clinics) {
        if (c.aiPhoneNumber) {
          await syncPlivoNumber(c.aiPhoneNumber).catch((err) => {
            console.error(`[plivo:sync] failed for ${c.aiPhoneNumber}:`, err.message);
          });
        }
      }
    }).catch(() => {});
  }
});
