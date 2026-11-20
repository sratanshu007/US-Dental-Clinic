// Background jobs: reminders, auto no-show, outbound AI calls / SMS, daily report, data retention.
import cron from "node-cron";
import { and, eq, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { config } from "../config";
import { db, schema } from "../db";
import { audit } from "../lib/audit";
import { formatUsPhone } from "../lib/phone";
import { isWithinLocalWindow, nextCallingTime, parseHHMM, speakable } from "../lib/time";
import { notifyClinic } from "../services/notify";
import { dailySummary } from "../services/reports";
import { setAppointmentStatus } from "../services/scheduling";
import { sendSms } from "../services/sms";

const running = new Set<string>();
async function once(name: string, fn: () => Promise<void>) {
  if (running.has(name)) return; // previous run still going
  running.add(name);
  try {
    await fn();
  } catch (e) {
    console.error(`[job:${name}]`, (e as Error).message);
  } finally {
    running.delete(name);
  }
}

/** SMS reminder N hours before the visit. */
export async function sendReminders() {
  const clinics = await db.query.clinics.findMany({ where: and(eq(schema.clinics.active, true), eq(schema.clinics.smsEnabled, true)) });
  for (const clinic of clinics) {
    const now = DateTime.now();
    const due = await db.query.appointments.findMany({
      where: and(
        eq(schema.appointments.clinicId, clinic.id),
        inArray(schema.appointments.status, ["BOOKED", "CONFIRMED"]),
        isNull(schema.appointments.reminderSentAt),
        gte(schema.appointments.startAt, now.plus({ hours: 2 }).toJSDate()),
        lte(schema.appointments.startAt, now.plus({ hours: clinic.reminderHoursBefore }).toJSDate()),
      ),
      with: { patient: true },
    });
    for (const a of due) {
      // Mark first so a crash never double-texts
      await db.update(schema.appointments).set({ reminderSentAt: new Date() }).where(eq(schema.appointments.id, a.id));
      const confirmAsk = a.status === "CONFIRMED" ? "" : " Reply C to confirm or R to reschedule.";
      await sendSms(clinic, a.patient, `${clinic.name} reminder: your appointment is ${speakable(a.startAt, clinic.timezone)}.${confirmAsk}`, "REMINDER");
    }
  }
}

/** Optional: mark unmarked past appointments as NO_SHOW after X minutes (clinic setting). */
export async function autoNoShow() {
  const clinics = await db.query.clinics.findMany({ where: eq(schema.clinics.active, true) });
  for (const clinic of clinics) {
    if (!clinic.autoNoShowAfterMinutes) continue;
    const cutoff = DateTime.now().minus({ minutes: clinic.autoNoShowAfterMinutes }).toJSDate();
    const stale = await db.query.appointments.findMany({
      where: and(
        eq(schema.appointments.clinicId, clinic.id),
        inArray(schema.appointments.status, ["BOOKED", "CONFIRMED"]),
        lt(schema.appointments.startAt, cutoff),
        gte(schema.appointments.startAt, DateTime.now().minus({ days: 2 }).toJSDate()),
      ),
    });
    for (const a of stale) {
      await setAppointmentStatus(clinic.id, a.id, "NO_SHOW");
      await audit(null, { action: "AUTO_NO_SHOW", entity: "appointment", entityId: a.id, clinicId: clinic.id }, "system");
    }
    if (stale.length) {
      await notifyClinic(clinic.id, "NO_SHOW", "No-shows recorded", `${stale.length} appointment(s) were not marked and are now no-shows. The AI will follow up.`, "/appointments");
    }
  }
}

/** Run pending no-show rebooking and feedback tasks (AI call or SMS). */
export async function dispatchOutbound() {
  // Recover tasks stuck "in progress" (voice agent crashed, no hangup callback)
  await db.update(schema.outboundTasks)
    .set({ status: "PENDING", lastError: "timed out", nextAttemptAt: new Date(Date.now() + 3600_000) })
    .where(and(eq(schema.outboundTasks.status, "IN_PROGRESS"), lt(schema.outboundTasks.updatedAt, new Date(Date.now() - 30 * 60_000))));

  const due = await db.query.outboundTasks.findMany({
    where: and(eq(schema.outboundTasks.status, "PENDING"), lte(schema.outboundTasks.nextAttemptAt, new Date())),
    with: { clinic: true, patient: true, appointment: true },
    limit: 20,
  });

  for (const task of due) {
    const { clinic, patient } = task;
    const nowLocal = DateTime.now().setZone(clinic.timezone);
    if (!clinic.active) continue;

    // TCPA / courtesy: only contact patients inside the clinic's calling hours
    if (!isWithinLocalWindow(nowLocal, clinic.callingHoursStart, clinic.callingHoursEnd)) {
      await db.update(schema.outboundTasks)
        .set({ nextAttemptAt: nextCallingTime(nowLocal, clinic.callingHoursStart, clinic.callingHoursEnd).toJSDate() })
        .where(eq(schema.outboundTasks.id, task.id));
      continue;
    }
    // Patient already rebooked something in the future? Skip the no-show call.
    if (task.purpose === "NO_SHOW_REBOOK") {
      const future = await db.query.appointments.findFirst({
        where: and(eq(schema.appointments.patientId, patient.id), gte(schema.appointments.startAt, new Date()), inArray(schema.appointments.status, ["BOOKED", "CONFIRMED"])),
      });
      if (future) {
        await db.update(schema.outboundTasks).set({ status: "CANCELLED", lastError: "already rebooked" }).where(eq(schema.outboundTasks.id, task.id));
        continue;
      }
    }

    // Claim the task atomically
    const [claimed] = await db.update(schema.outboundTasks)
      .set({ status: "IN_PROGRESS", attempts: sql`${schema.outboundTasks.attempts} + 1` })
      .where(and(eq(schema.outboundTasks.id, task.id), eq(schema.outboundTasks.status, "PENDING")))
      .returning();
    if (!claimed) continue;

    if (task.channel === "SMS") {
      const text = task.purpose === "FEEDBACK"
        ? `Thanks for visiting ${clinic.name}! How was your visit? Reply with a number 1-5 (5 = great) and any comments.`
        : `${clinic.name}: we missed you today. Call ${formatUsPhone(clinic.aiPhoneNumber)} any time to pick a new time.`;
      const r = await sendSms(clinic, patient, text, task.purpose === "FEEDBACK" ? "FEEDBACK_REQUEST" : "NO_SHOW");
      await db.update(schema.outboundTasks).set({ status: r.sent ? "DONE" : "FAILED", lastError: r.reason }).where(eq(schema.outboundTasks.id, task.id));
      continue;
    }

    // CALL channel
    if (!clinic.aiEnabled || !patient.callConsent) {
      // No consent to call: fall back to SMS if allowed, else give up
      if (patient.smsConsent && !patient.smsOptOut) {
        await db.update(schema.outboundTasks).set({ status: "PENDING", channel: "SMS", attempts: 0 }).where(eq(schema.outboundTasks.id, task.id));
      } else {
        await db.update(schema.outboundTasks).set({ status: "CANCELLED", lastError: "no call/SMS consent" }).where(eq(schema.outboundTasks.id, task.id));
      }
      continue;
    }

    if (config.dryRun) {
      console.log(`[outbound:dry-run] would call patient for ${task.purpose} (task ${task.id})`);
      await db.update(schema.outboundTasks).set({ status: "DONE", lastError: "dry run" }).where(eq(schema.outboundTasks.id, task.id));
      continue;
    }
    try {
      const r = await fetch(`${config.voiceAgentUrl}/outbound/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Key": config.internalApiKey },
        body: JSON.stringify({ taskId: task.id, to: patient.phone, from: clinic.aiPhoneNumber }),
      });
      if (!r.ok) throw new Error(`voice agent ${r.status}`);
    } catch (e) {
      await db.update(schema.outboundTasks)
        .set({ status: "PENDING", lastError: (e as Error).message, nextAttemptAt: new Date(Date.now() + 15 * 60_000) })
        .where(eq(schema.outboundTasks.id, task.id));
    }
  }
}

/** Push the day's summary to the clinic at its report time. Counts only — no PHI in the push. */
export async function dailyReports() {
  const clinics = await db.query.clinics.findMany({ where: eq(schema.clinics.active, true) });
  for (const clinic of clinics) {
    const now = DateTime.now().setZone(clinic.timezone);
    const today = now.toISODate()!;
    if (clinic.lastDailyReportDate === today) continue;
    if (now < now.set({ ...parseHHMM(clinic.dailyReportTime), second: 0 })) continue;
    const s = await dailySummary(clinic.id, today);
    await db.update(schema.clinics).set({ lastDailyReportDate: today }).where(eq(schema.clinics.id, clinic.id));
    await notifyClinic(
      clinic.id,
      "DAILY_REPORT",
      `Daily report — ${now.toFormat("LLL d")}`,
      `${s.showed} came, ${s.noShow} no-show${s.unmarked ? `, ${s.unmarked} not marked` : ""}. AI booked ${s.newBookingsByAi}, handled ${s.callsHandled} calls, ${s.newLeads} new inquiries.`,
      `/reports?date=${today}`,
    );
  }
}

/** Morning CRM digest: how many follow-ups are due today / overdue (counts only). */
export async function taskDigest() {
  const clinics = await db.query.clinics.findMany({ where: eq(schema.clinics.active, true) });
  for (const clinic of clinics) {
    const now = DateTime.now().setZone(clinic.timezone);
    const today = now.toISODate()!;
    if (clinic.lastTaskDigestDate === today) continue;
    if (now < now.set({ ...parseHHMM(clinic.taskDigestTime), second: 0 })) continue;
    await db.update(schema.clinics).set({ lastTaskDigestDate: today }).where(eq(schema.clinics.id, clinic.id));
    const [t] = await db.select({
      due: sql<number>`count(*) filter (where ${schema.crmTasks.dueAt} <= ${now.endOf("day").toJSDate()})::int`,
      overdue: sql<number>`count(*) filter (where ${schema.crmTasks.dueAt} < ${new Date()})::int`,
    }).from(schema.crmTasks).where(and(eq(schema.crmTasks.clinicId, clinic.id), isNull(schema.crmTasks.doneAt)));
    if (t.due > 0) {
      await notifyClinic(clinic.id, "TASKS", `${t.due} follow-up${t.due === 1 ? "" : "s"} due today`,
        `${t.overdue ? `${t.overdue} overdue. ` : ""}Open the CRM to call back your leads.`, "/crm?tab=Tasks");
    }
  }
}

/** HIPAA minimum necessary: delete transcripts / summaries / SMS bodies after the retention period. */
export async function purgeOldData() {
  const clinics = await db.query.clinics.findMany();
  for (const clinic of clinics) {
    const cutoff = DateTime.now().minus({ days: clinic.retentionDays }).toJSDate();
    await db.update(schema.calls).set({ transcriptEnc: null, summaryEnc: null })
      .where(and(eq(schema.calls.clinicId, clinic.id), lt(schema.calls.startedAt, cutoff)));
    await db.delete(schema.smsMessages).where(and(eq(schema.smsMessages.clinicId, clinic.id), lt(schema.smsMessages.createdAt, cutoff)));
  }
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date()));
}

export function startJobs() {
  cron.schedule("* * * * *", () => {
    void once("reminders", sendReminders);
    void once("dispatch", dispatchOutbound);
    void once("dailyReports", dailyReports);
    void once("taskDigest", taskDigest);
  });
  cron.schedule("*/5 * * * *", () => void once("autoNoShow", autoNoShow));
  cron.schedule("17 3 * * *", () => void once("purge", purgeOldData));
  console.log("[jobs] scheduled");
}
