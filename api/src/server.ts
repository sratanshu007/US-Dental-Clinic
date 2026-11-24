import { createApp } from "./app";
import { config } from "./config";
import { startJobs } from "./jobs";
import { alert, scrub } from "./lib/alerts";
import { enforceProductionSecurity } from "./lib/securityCheck";

enforceProductionSecurity();

process.on("unhandledRejection", (e) => {
  void alert("unhandledRejection", `Unhandled promise rejection: ${scrub(String((e as Error)?.message ?? e))}`);
});
process.on("uncaughtException", (e) => {
  console.error(e);
  void alert("uncaughtException", `Uncaught exception: ${scrub(e.message)} — process restarting`, 1).finally(() => process.exit(1));
});

const app = createApp();
app.listen(config.port, () => {
  console.log(`[api] listening on :${config.port} (${config.env})${config.dryRun ? " — DRY RUN: SMS/calls are not sent" : ""}`);
  if (config.jobsEnabled) startJobs();
  void alert("startup", `API started (${config.env})`, 1);
});
