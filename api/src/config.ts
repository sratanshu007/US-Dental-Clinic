import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function normalizeUrl(url: string, defaultProtocol = "https://"): string {
  if (!url) return "";
  let trimmed = url.trim().replace(/\/$/, "");
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    if (trimmed.startsWith("localhost") || trimmed.includes("localhost:")) {
      trimmed = `http://${trimmed}`;
    } else {
      trimmed = `${defaultProtocol}${trimmed}`;
    }
  }
  return trimmed;
}

export const config = {
  env: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),
  databaseSsl: process.env.DATABASE_SSL === "true",
  jwtSecret: required("JWT_SECRET"),
  // 64 hex chars = 32 bytes, used for AES-256-GCM field encryption
  encryptionKey: required("ENCRYPTION_KEY"),
  // Shared secret between this API and the voice agent
  internalApiKey: required("INTERNAL_API_KEY"),
  // Optional: only accept /internal calls from these IPs (comma-separated), e.g. the voice container
  internalAllowedIps: (process.env.INTERNAL_ALLOWED_IPS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  requireAdminMfa: process.env.REQUIRE_ADMIN_MFA === "true",
  // Account lockout after repeated wrong passwords
  maxFailedLogins: Number(process.env.MAX_FAILED_LOGINS ?? 5),
  lockoutMinutes: Number(process.env.LOCKOUT_MINUTES ?? 15),
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:3000").split(",").map((s) => s.trim()),
  publicApiUrl: normalizeUrl(process.env.PUBLIC_API_URL ?? process.env.RENDER_EXTERNAL_URL ?? "http://localhost:4000"),
  // Public base URL for secure patient links in texts, e.g. https://dd-care.com (proxied to this API).
  // Use your own short domain — carriers often block public link shorteners.
  patientLinkBase: normalizeUrl(process.env.PATIENT_LINK_BASE ?? process.env.PUBLIC_API_URL ?? process.env.RENDER_EXTERNAL_URL ?? "http://localhost:4000"),
  voiceAgentUrl: normalizeUrl(process.env.VOICE_AGENT_URL ?? "http://localhost:7860"),
  plivo: {
    authId: process.env.PLIVO_AUTH_ID ?? "",
    authToken: process.env.PLIVO_AUTH_TOKEN ?? "",
    // Transport-only mode: ask Plivo not to store SMS text (and to mask the patient number) in its logs.
    // Keep this on unless you have a BAA with Plivo and need its message logs for debugging.
    redactSms: process.env.PLIVO_REDACT_SMS !== "false",
  },
  openDental: {
    apiUrl: process.env.OPEN_DENTAL_API_URL ?? "https://api.opendental.com/api/v1",
    // Ours, from Open Dental's Developer Portal (vendor.relations@opendental.com). Each office adds its own customer key.
    developerKey: process.env.OPEN_DENTAL_DEVELOPER_KEY ?? "",
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    // Price IDs from the Stripe dashboard (recurring monthly, USD)
    prices: {
      STARTER: process.env.STRIPE_PRICE_STARTER ?? "",
      GROWTH: process.env.STRIPE_PRICE_GROWTH ?? "",
      PRO: process.env.STRIPE_PRICE_PRO ?? "",
      SETUP_STANDARD: process.env.STRIPE_PRICE_SETUP_STANDARD ?? "",
      SETUP_PREMIUM: process.env.STRIPE_PRICE_SETUP_PREMIUM ?? "",
    },
  },
  // Operations alerts (Slack/Discord/Teams incoming webhook). Messages never contain patient data.
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL ?? "",
  webAppUrl: (process.env.WEB_APP_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  accessTokenMinutes: Number(process.env.ACCESS_TOKEN_MINUTES ?? 15),
  refreshTokenDays: Number(process.env.REFRESH_TOKEN_DAYS ?? 7),
  // Turn background jobs off for one-off scripts / tests
  jobsEnabled: process.env.JOBS_ENABLED !== "false",
  // When true, SMS and outbound calls are logged instead of sent (local dev / demos)
  dryRun: process.env.DRY_RUN === "true" || !process.env.PLIVO_AUTH_ID,
};
