// CRM: contacts/deals (leads table), activity timeline and follow-up tasks.
import { and, desc, eq, notInArray } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, schema } from "../db";
import type { Lead } from "../db/schema";
import { encrypt } from "../lib/crypto";
import { nextCallingTime } from "../lib/time";
import { getClinic } from "./scheduling";

export type Stage = "NEW" | "CONTACTED" | "APPT" | "PLAN" | "WON" | "LOST";
export type ActivityType = "CALL" | "SMS" | "EMAIL" | "NOTE" | "APPT" | "STAGE" | "TASK" | "CREATED";
export const STAGE_LABEL: Record<Stage, string> = {
  NEW: "New inquiry", CONTACTED: "Contacted", APPT: "Appointment booked", PLAN: "Treatment plan sent", WON: "Won", LOST: "Lost",
};
export const CLOSED: Stage[] = ["WON", "LOST"];

export async function logActivity(lead: Pick<Lead, "id" | "clinicId">, type: ActivityType, text: string | null, actor: string, userId?: string | null) {
  await db.insert(schema.crmActivities).values({ clinicId: lead.clinicId, leadId: lead.id, type, textEnc: encrypt(text), actor, userId: userId ?? null });
  await db.update(schema.leads).set({ lastActivityAt: new Date() }).where(eq(schema.leads.id, lead.id));
}

export async function setStage(lead: Lead, stage: Stage, actor: string, userId?: string | null): Promise<Lead> {
  if (lead.status === stage) return lead;
  const [l] = await db.update(schema.leads)
    .set({ status: stage, closedAt: CLOSED.includes(stage) ? new Date() : null })
    .where(eq(schema.leads.id, lead.id)).returning();
  await logActivity(lead, "STAGE", `Moved from ${STAGE_LABEL[lead.status as Stage]} to ${STAGE_LABEL[stage]}.`, actor, userId);
  return l;
}

/** Open (not won/lost) CRM contact for this phone, if any. */
export async function openLeadForPhone(clinicId: string, phone: string) {
  return db.query.leads.findFirst({
    where: and(eq(schema.leads.clinicId, clinicId), eq(schema.leads.phone, phone), notInArray(schema.leads.status, CLOSED)),
    orderBy: desc(schema.leads.createdAt),
  });
}

export interface NewLead {
  clinicId: string;
  phone: string;
  name?: string | null;
  email?: string | null;
  interest?: string | null;
  source?: string;
  value?: number;
  ownerId?: string | null;
  tags?: string[];
  patientId?: string | null;
  stage?: Stage;
  actor: string;
  userId?: string | null;
  activity?: { type: ActivityType; text: string };
  /** Follow-up task. dueInMinutes is moved into the clinic's calling hours. */
  task?: { title: string; type?: "CALL" | "TEXT" | "EMAIL" | "OTHER"; dueInMinutes?: number; dueAt?: Date };
}

export async function createLead(input: NewLead): Promise<Lead> {
  const [lead] = await db.insert(schema.leads).values({
    clinicId: input.clinicId, phone: input.phone, name: input.name ?? null, email: input.email ?? null,
    interest: input.interest ?? null, source: input.source ?? "AI call", value: input.value ?? 0,
    ownerId: input.ownerId ?? null, tags: input.tags ?? [], patientId: input.patientId ?? null, status: input.stage ?? "NEW",
    closedAt: input.stage && CLOSED.includes(input.stage) ? new Date() : null,
  }).returning();
  await logActivity(lead, "CREATED", `Contact created (${lead.source}).`, input.actor, input.userId);
  if (input.activity) await logActivity(lead, input.activity.type, input.activity.text, input.actor, input.userId);
  if (input.task) await addTask(lead, input.task, input.ownerId ?? null);
  return lead;
}

export async function addTask(
  lead: Pick<Lead, "id" | "clinicId" | "ownerId">,
  t: { title: string; type?: "CALL" | "TEXT" | "EMAIL" | "OTHER"; dueInMinutes?: number; dueAt?: Date },
  ownerId?: string | null,
) {
  let due = t.dueAt;
  if (!due) {
    const clinic = await getClinic(lead.clinicId);
    const at = DateTime.now().setZone(clinic.timezone).plus({ minutes: t.dueInMinutes ?? 60 });
    due = nextCallingTime(at, clinic.callingHoursStart, clinic.callingHoursEnd).toJSDate();
  }
  const [task] = await db.insert(schema.crmTasks).values({
    clinicId: lead.clinicId, leadId: lead.id, title: t.title, type: t.type ?? "CALL", dueAt: due, ownerId: ownerId ?? lead.ownerId ?? null,
  }).returning();
  return task;
}

/** A patient asked to reschedule (text reply "R" or the secure link). Adds a call-back task for the team. */
export async function requestReschedule(clinicId: string, patient: { id: string; phone: string; firstName: string | null; lastName: string | null }, via: "SMS" | "LINK") {
  const label = via === "SMS" ? "text" : "secure link";
  const existing = await openLeadForPhone(clinicId, patient.phone);
  if (existing) {
    await logActivity(existing, "SMS", `Asked to reschedule by ${label}.`, "AI receptionist");
    await addTask(existing, { title: `Reschedule request (${label})`, type: "CALL", dueInMinutes: 30 });
  } else {
    await createLead({
      clinicId, patientId: patient.id, phone: patient.phone, name: [patient.firstName, patient.lastName].filter(Boolean).join(" ") || null,
      interest: `Wants to reschedule (${label})`, source: via === "SMS" ? "AI SMS" : "Patient link", stage: "CONTACTED", actor: "AI receptionist",
      task: { title: `Reschedule request (${label})`, type: "CALL", dueInMinutes: 30 },
    });
  }
}
