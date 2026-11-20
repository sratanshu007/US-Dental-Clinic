import { and, avg, count, eq, gte, lt, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, schema } from "../db";
import { getClinic } from "./scheduling";

/** Day summary: who came, who didn't, what the AI did. Aggregates only (safe for push). */
export async function dailySummary(clinicId: string, dateISO?: string) {
  const clinic = await getClinic(clinicId);
  const tz = clinic.timezone;
  const day = dateISO ? DateTime.fromISO(dateISO, { zone: tz }) : DateTime.now().setZone(tz);
  const from = day.startOf("day").toJSDate();
  const to = day.endOf("day").toJSDate();
  const A = schema.appointments;

  const byStatus = await db
    .select({ status: A.status, n: count() })
    .from(A)
    .where(and(eq(A.clinicId, clinicId), gte(A.startAt, from), lt(A.startAt, to)))
    .groupBy(A.status);
  const s = Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)])) as Record<string, number>;

  const [{ n: newBookingsByAi }] = await db
    .select({ n: count() })
    .from(A)
    .where(and(eq(A.clinicId, clinicId), gte(A.createdAt, from), lt(A.createdAt, to), sql`${A.source} <> 'STAFF'`));

  const [{ n: callsHandled }] = await db
    .select({ n: count() })
    .from(schema.calls)
    .where(and(eq(schema.calls.clinicId, clinicId), gte(schema.calls.startedAt, from), lt(schema.calls.startedAt, to)));

  const [{ n: newLeads }] = await db
    .select({ n: count() })
    .from(schema.leads)
    .where(and(eq(schema.leads.clinicId, clinicId), gte(schema.leads.createdAt, from), lt(schema.leads.createdAt, to)));

  const [{ a: avgRating, n: feedbackCount }] = await db
    .select({ a: avg(schema.feedback.rating), n: count() })
    .from(schema.feedback)
    .where(and(eq(schema.feedback.clinicId, clinicId), gte(schema.feedback.createdAt, from), lt(schema.feedback.createdAt, to)));

  const scheduled = (s.BOOKED ?? 0) + (s.CONFIRMED ?? 0) + (s.SHOWED ?? 0) + (s.NO_SHOW ?? 0);
  return {
    date: day.toISODate(),
    scheduled,
    showed: s.SHOWED ?? 0,
    noShow: s.NO_SHOW ?? 0,
    unmarked: (s.BOOKED ?? 0) + (s.CONFIRMED ?? 0),
    cancelled: s.CANCELLED ?? 0,
    rescheduled: s.RESCHEDULED ?? 0,
    newBookingsByAi: Number(newBookingsByAi),
    callsHandled: Number(callsHandled),
    newLeads: Number(newLeads),
    feedbackCount: Number(feedbackCount),
    avgRating: avgRating ? Math.round(Number(avgRating) * 10) / 10 : null,
  };
}

/** Totals over a date range for the dashboard charts. */
export async function rangeSummary(clinicId: string, fromISO: string, toISO: string) {
  const clinic = await getClinic(clinicId);
  const out = [];
  for (
    let d = DateTime.fromISO(fromISO, { zone: clinic.timezone });
    d <= DateTime.fromISO(toISO, { zone: clinic.timezone });
    d = d.plus({ days: 1 })
  ) {
    out.push(await dailySummary(clinicId, d.toISODate()!));
    if (out.length > 62) break;
  }
  return out;
}
