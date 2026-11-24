// Refuse to start in production with unsafe settings. Better a failed deploy than an open door.
import { config } from "../config";

export function securityProblems(env = process.env): string[] {
  const p: string[] = [];
  const hex64 = /^[0-9a-f]{64}$/i;
  if (config.jwtSecret.length < 32) p.push("JWT_SECRET must be at least 32 characters (openssl rand -hex 32)");
  if (!hex64.test(config.encryptionKey)) p.push("ENCRYPTION_KEY must be 64 hex characters (openssl rand -hex 32)");
  if (config.internalApiKey.length < 32) p.push("INTERNAL_API_KEY must be at least 32 characters");
  const secrets = [config.jwtSecret, config.encryptionKey, config.internalApiKey];
  if (new Set(secrets).size !== secrets.length) p.push("JWT_SECRET, ENCRYPTION_KEY and INTERNAL_API_KEY must all be different");
  if (/change|example|dev-|secret|password/i.test(config.jwtSecret + config.internalApiKey)) p.push("Secrets look like placeholders — generate real ones");
  if (config.corsOrigins.some((o) => o === "*" || !o.startsWith("https://"))) p.push("CORS_ORIGINS must list your https:// dashboard origin(s) only");
  if (!config.databaseSsl && !/localhost|127\.0\.0\.1|@db:/.test(config.databaseUrl)) p.push("DATABASE_SSL=true is required for a remote database");
  if (env.VERIFY_PLIVO_SIGNATURE === "false") p.push("VERIFY_PLIVO_SIGNATURE must not be false in production");
  if (config.dryRun) p.push("DRY_RUN is on (or PLIVO_AUTH_ID is missing): texts and calls would be silently dropped");
  if (!config.publicApiUrl.startsWith("https://")) p.push("PUBLIC_API_URL must be https://");
  return p;
}

export function enforceProductionSecurity(): void {
  if (config.env !== "production") return;
  const problems = securityProblems();
  if (problems.length) {
    console.error("[security] refusing to start in production:\n - " + problems.join("\n - "));
    process.exit(1);
  }
}
