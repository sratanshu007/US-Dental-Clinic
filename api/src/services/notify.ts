import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db";

/**
 * In-app notification + mobile push to every active user of the clinic.
 * HIPAA: title/body must never contain patient names, phone numbers or health details —
 * lock screens show push text. The app opens the record after the user signs in.
 */
export async function notifyClinic(
  clinicId: string,
  type: string,
  title: string,
  body: string,
  link?: string,
) {
  await db.insert(schema.notifications).values({ clinicId, type, title, body, link });

  const rows = await db
    .select({ token: schema.pushTokens.token })
    .from(schema.pushTokens)
    .innerJoin(schema.users, eq(schema.users.id, schema.pushTokens.userId))
    .where(and(eq(schema.users.clinicId, clinicId), eq(schema.users.active, true)));

  if (rows.length) await sendExpoPush(rows.map((r) => r.token), title, body, { type, link });
}

async function sendExpoPush(tokens: string[], title: string, body: string, data: Record<string, unknown>) {
  const messages = tokens.map((to) => ({ to, title, body, data, sound: "default" }));
  try {
    for (let i = 0; i < messages.length; i += 100) {
      const res = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(messages.slice(i, i + 100)),
      });
      const json = (await res.json()) as { data?: { status: string; details?: { error?: string } }[] };
      // Remove tokens for uninstalled apps
      const dead = (json.data ?? [])
        .map((r, idx) => (r.details?.error === "DeviceNotRegistered" ? messages[i + idx].to : null))
        .filter((t): t is string => !!t);
      if (dead.length) await db.delete(schema.pushTokens).where(inArray(schema.pushTokens.token, dead));
    }
  } catch (e) {
    console.error("[push] failed", (e as Error).message);
  }
}
