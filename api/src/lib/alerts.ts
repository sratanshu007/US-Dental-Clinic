// Operations alerts to a Slack / Discord / Teams incoming webhook.
// Never include patient data: only job names, clinic IDs, counts and error classes.
import { config } from "../config";

const recent = new Map<string, number>();

/** Send an alert, at most once per `key` every `everyMinutes` (default 30) so a failing job doesn't flood the channel. */
export async function alert(key: string, message: string, everyMinutes = 30): Promise<void> {
  const now = Date.now();
  const last = recent.get(key) ?? 0;
  if (now - last < everyMinutes * 60_000) return;
  recent.set(key, now);
  const text = `[dental-ai ${config.env}] ${message}`.slice(0, 1500);
  console.error(`[alert] ${text}`);
  if (!config.alertWebhookUrl) return;
  try {
    // Slack uses "text", Discord uses "content"; sending both works for either.
    await fetch(config.alertWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, content: text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.error("[alert] webhook failed", (e as Error).message);
  }
}

/** Strip anything that looks like a phone number, email or date before it goes into an alert or log. */
export function scrub(s: string): string {
  return s
    .replace(/\+?\d[\d\s().-]{8,}\d/g, "[number]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "[date]");
}
