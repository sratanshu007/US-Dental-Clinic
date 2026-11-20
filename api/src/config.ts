import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const config = {
  env: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),
  databaseSsl: process.env.DATABASE_SSL === "true",
  jwtSecret: required("JWT_SECRET"),
  // 64 hex chars = 32 bytes, used for AES-256-GCM field encryption
  encryptionKey: required("ENCRYPTION_KEY"),
  // Shared secret between this API and the Python voice agent
  internalApiKey: required("INTERNAL_API_KEY"),
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:3000").split(",").map((s) => s.trim()),
  publicApiUrl: process.env.PUBLIC_API_URL ?? "http://localhost:4000",
  voiceAgentUrl: process.env.VOICE_AGENT_URL ?? "http://localhost:7860",
  plivo: {
    authId: process.env.PLIVO_AUTH_ID ?? "",
    authToken: process.env.PLIVO_AUTH_TOKEN ?? "",
  },
  accessTokenMinutes: Number(process.env.ACCESS_TOKEN_MINUTES ?? 60),
  refreshTokenDays: Number(process.env.REFRESH_TOKEN_DAYS ?? 7),
  // Turn background jobs off for one-off scripts / tests
  jobsEnabled: process.env.JOBS_ENABLED !== "false",
  // When true, SMS and outbound calls are logged instead of sent (local dev / demos)
  dryRun: process.env.DRY_RUN === "true" || !process.env.PLIVO_AUTH_ID,

  // Login credentials & Clinic info (configured via environment)
  adminEmail: (process.env.ADMIN_EMAIL ?? process.env.SEED_ADMIN_EMAIL ?? "admin@deificdigital.com").toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe-Admin-2026",
  ownerEmail: (process.env.OWNER_EMAIL ?? process.env.SEED_OWNER_EMAIL ?? "owner@demo-dental.com").toLowerCase(),
  ownerPassword: process.env.OWNER_PASSWORD ?? process.env.SEED_OWNER_PASSWORD ?? "ChangeMe-Owner-2026",
  clinicName: process.env.CLINIC_NAME ?? process.env.SEED_CLINIC_NAME ?? "Demo Family Dental",
  clinicPhone: process.env.CLINIC_PHONE ?? process.env.SEED_CLINIC_NUMBER ?? "+12105550100",
  clinicTransferPhone: process.env.CLINIC_TRANSFER_PHONE ?? "+12105550199",
  clinicTimezone: process.env.CLINIC_TIMEZONE ?? "America/Chicago",
  clinicAddress: process.env.CLINIC_ADDRESS ?? "123 Main St, San Antonio, TX",
};
