import { and, avg, count, eq, gte, lt, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, schema } from "../db";
import type { Clinic } from "../db/schema";
import { getClinic } from "./scheduling";

/** Day summary: who came, who didn't, what the AI did. Aggregates only (safe for push). */
export async function dailySummary(clinicId: string, dateISO?: string, preloadedClinic?: Clinic) {
  const clinic = preloadedClinic ?? (await getClinic(clinicId));
  const tz = clinic.timezone;
  const day = dateISO ? DateTime.fromISO(dateISO, { zone: tz }) : DateTime.now().setZone(tz);
  const from = day.startOf("day").toJSDate();
  const to = day.endOf("day").toJSDate();
  const A = schema.appointments;

  const [
    byStatus,
    bookingsResult,
    callsResult,
    leadsResult,
    feedbackResult,
  ] = await Promise.all([
    db
      .select({ status: A.status, n: count() })
      .from(A)
      .where(and(eq(A.clinicId, clinicId), gte(A.startAt, from), lt(A.startAt, to)))
      .groupBy(A.status),
    db
      .select({ n: count() })
      .from(A)
      .where(and(eq(A.clinicId, clinicId), gte(A.createdAt, from), lt(A.createdAt, to), sql`${A.source} <> 'STAFF'`)),
    db
      .select({ n: count() })
      .from(schema.calls)
      .where(and(eq(schema.calls.clinicId, clinicId), gte(schema.calls.startedAt, from), lt(schema.calls.startedAt, to))),
    db
      .select({ n: count() })
      .from(schema.leads)
      .where(and(eq(schema.leads.clinicId, clinicId), gte(schema.leads.createdAt, from), lt(schema.leads.createdAt, to))),
    db
      .select({ a: avg(schema.feedback.rating), n: count() })
      .from(schema.feedback)
      .where(and(eq(schema.feedback.clinicId, clinicId), gte(schema.feedback.createdAt, from), lt(schema.feedback.createdAt, to))),
  ]);

  const s = Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)])) as Record<string, number>;
  const newBookingsByAi = bookingsResult[0]?.n ?? 0;
  const callsHandled = callsResult[0]?.n ?? 0;
  const newLeads = leadsResult[0]?.n ?? 0;
  const avgRating = feedbackResult[0]?.a ?? null;
  const feedbackCount = feedbackResult[0]?.n ?? 0;

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
export async function rangeSummary(clinicId: string, fromISO: string, toISO: string, preloadedClinic?: Clinic) {
  const clinic = preloadedClinic ?? (await getClinic(clinicId));
  const days: string[] = [];
  for (
    let d = DateTime.fromISO(fromISO, { zone: clinic.timezone });
    d <= DateTime.fromISO(toISO, { zone: clinic.timezone });
    d = d.plus({ days: 1 })
  ) {
    days.push(d.toISODate()!);
    if (days.length > 62) break;
  }
  return Promise.all(days.map((d) => dailySummary(clinicId, d, clinic)));
}
