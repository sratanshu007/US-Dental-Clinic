import { createApp } from "./app";
import { config } from "./config";
import { startJobs } from "./jobs";

const app = createApp();
app.listen(config.port, "0.0.0.0", () => {
  console.log(`[api] listening on :${config.port} (${config.env})${config.dryRun ? " — DRY RUN: SMS/calls are not sent" : ""}`);
  if (config.jobsEnabled) startJobs();
});
