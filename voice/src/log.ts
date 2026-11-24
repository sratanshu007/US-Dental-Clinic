// Minimal structured logger. HIPAA: never log what callers say, phone numbers or names.
import { config } from "./config";

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;
const min = levels[(config.logLevel as Level) in levels ? (config.logLevel as Level) : "info"];

function out(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (levels[level] < min) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...meta });
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}
export const log = {
  debug: (m: string, meta?: Record<string, unknown>) => out("debug", m, meta),
  info: (m: string, meta?: Record<string, unknown>) => out("info", m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => out("warn", m, meta),
  error: (m: string, meta?: Record<string, unknown>) => out("error", m, meta),
};
