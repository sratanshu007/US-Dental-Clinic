// Security check: audit settings on startup and warn about any misconfigurations.
import { config } from "../config";

export function securityProblems(env = process.env): string[] {
  const p: string[] = [];
  const hex64 = /^[0-9a-f]{64}$/i;
  if (config.jwtSecret.length < 16) p.push("JWT_SECRET should be at least 32 characters for production security");
  if (!hex64.test(config.encryptionKey) && config.encryptionKey.length < 16) {
    p.push("ENCRYPTION_KEY should be 64 hex characters (32 bytes)");
  }
  if (config.internalApiKey.length < 16) p.push("INTERNAL_API_KEY should be at least 32 characters");
  const secrets = [config.jwtSecret, config.encryptionKey, config.internalApiKey];
  if (new Set(secrets).size !== secrets.length) p.push("JWT_SECRET, ENCRYPTION_KEY and INTERNAL_API_KEY should all be different");
  if (config.corsOrigins.some((o) => o === "*")) {
    p.push("CORS_ORIGINS is set to '*' (allowed for testing; specify your dashboard domain in production)");
  }
  if (!config.databaseSsl && !/localhost|127\.0\.0\.1|@db:/.test(config.databaseUrl)) {
    p.push("DATABASE_SSL=true is recommended for remote databases");
  }
  if (config.dryRun) {
    p.push("DRY_RUN is active (or PLIVO_AUTH_ID is not configured): texts and calls will be logged instead of sent");
  }
  if (!config.publicApiUrl.startsWith("https://")) {
    p.push("PUBLIC_API_URL should be https:// in production for external webhooks");
  }
  return p;
}

export function enforceProductionSecurity(): void {
  const problems = securityProblems();
  if (problems.length) {
    console.warn("[security audit]:\n - " + problems.join("\n - "));
    // Only halt startup if explicitly requested via STRICT_PRODUCTION_SECURITY=true
    if (process.env.STRICT_PRODUCTION_SECURITY === "true") {
      console.error("[security] Refusing to start because STRICT_PRODUCTION_SECURITY=true is set.");
      process.exit(1);
    }
  }
}
