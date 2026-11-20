// CRM API: contacts/deals, pipeline, activity timeline, follow-up tasks.
import { Router } from "express";
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import { db, schema } from "../db";
import { audit } from "../lib/audit";
import { decrypt } from "../lib/crypto";
import { ah, badRequest, notFound } from "../lib/http";
import { normalizeUsPhone } from "../lib/phone";
import { clinicScope, requireAuth } from "../middleware/auth";
import { addTask, CLOSED, createLead, logActivity, setStage, STAGE_LABEL, type Stage } from "../services/crm";
import { getClinic } from "../services/scheduling";

export const crmRouter = Router();
crmRouter.use(requireAuth);

const STAGES = ["NEW", "CONTACTED", "APPT", "PLAN", "WON", "LOST"] as const;
const stageSchema = z.enum(STAGES);
const taskType = z.enum(["CALL", "TEXT", "EMAIL", "OTHER"]);

async function actorName(userId: string) {
  const u = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  return u?.name ?? "Staff";
}

async function ownerInClinic(clinicId: string, ownerId: string | null | undefined) {
  if (!ownerId) return null;
  const u = await db.query.users.findFirst({ where: and(eq(schema.users.id, ownerId), eq(schema.users.clinicId, clinicId)) });
  if (!u) throw badRequest("Owner must be a member of this clinic");
  return u.id;
}

async function getLead(clinicId: string, id: string) {
  const l = await db.query.leads.findFirst({ where: and(eq(schema.leads.id, id), eq(schema.leads.clinicId, clinicId)) });
  if (!l) throw notFound("Contact not found");
  return l;
}

const leadView = (l: any, nextTask?: any) => ({
  id: l.id, name: l.name, phone: l.phone, email: l.email, interest: l.interest, stage: l.status, stageLabel: STAGE_LABEL[l.status as Stage],
  source: l.source, value: l.value, tags: l.tags, ownerId: l.ownerId, owner: l.owner ? { id: l.owner.id, name: l.owner.name } : null,
  patientId: l.patientId, createdAt: l.createdAt, lastActivityAt: l.lastActivityAt, closedAt: l.closedAt,
  nextTask: nextTask ? { id: nextTask.id, title: nextTask.title, dueAt: nextTask.dueAt, type: nextTask.type } : null,
});

// ---------------- summary (pipeline stats) ----------------
crmRouter.get("/summary", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const clinic = await getClinic(clinicId);
  const byStage = await db
    .select({ stage: schema.leads.status, n: sql<number>`count(*)::int`, value: sql<number>`coalesce(sum(${schema.leads.value}),0)::int` })
    .from(schema.leads).where(eq(schema.leads.clinicId, clinicId)).groupBy(schema.leads.status);
  const monthStart = DateTime.now().setZone(clinic.timezone).startOf("month").toJSDate();
  const [won] = await db.select({ n: sql<number>`count(*)::int`, value: sql<number>`coalesce(sum(${schema.leads.value}),0)::int` })
    .from(schema.leads).where(and(eq(schema.leads.clinicId, clinicId), eq(schema.leads.status, "WON"), gte(schema.leads.closedAt, monthStart)));
  const [fromAi] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.leads)
    .where(and(eq(schema.leads.clinicId, clinicId), ilike(schema.leads.source, "AI%")));
  const now = new Date();
  const endOfToday = DateTime.now().setZone(clinic.timezone).endOf("day").toJSDate();
  const [tasks] = await db.select({
    overdue: sql<number>`count(*) filter (where ${schema.crmTasks.dueAt} < ${now})::int`,
    dueToday: sql<number>`count(*) filter (where ${schema.crmTasks.dueAt} <= ${endOfToday})::int`,
  }).from(schema.crmTasks).where(and(eq(schema.crmTasks.clinicId, clinicId), isNull(schema.crmTasks.doneAt)));
  const stages = Object.fromEntries(STAGES.map((s) => [s, { count: 0, value: 0 }]));
  for (const r of byStage) stages[r.stage] = { count: r.n, value: r.value };
  const wonAll = stages.WON.count, lostAll = stages.LOST.count;
  res.json({
    stages,
    openPipeline: STAGES.filter((s) => !CLOSED.includes(s)).reduce((t, s) => t + stages[s].value, 0),
    openCount: STAGES.filter((s) => !CLOSED.includes(s)).reduce((t, s) => t + stages[s].count, 0),
    wonThisMonth: won, winRate: wonAll + lostAll ? Math.round((wonAll / (wonAll + lostAll)) * 100) : 0,
    fromAi: fromAi.n, total: byStage.reduce((t, r) => t + r.n, 0), tasks,
  });
}));

// ---------------- contacts ----------------
crmRouter.get("/leads", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const q = z.object({
    q: z.string().optional(), stage: z.string().optional(), source: z.string().optional(), ownerId: z.string().optional(),
    tag: z.string().optional(), open: z.enum(["1", "0"]).optional(),
  }).parse(req.query);
  const stages = q.stage?.split(",").filter((s): s is Stage => (STAGES as readonly string[]).includes(s));
  const term = q.q?.trim();
  const rows = await db.query.leads.findMany({
    where: and(
      eq(schema.leads.clinicId, clinicId),
      stages?.length ? inArray(schema.leads.status, stages) : undefined,
      q.open === "1" ? sql`${schema.leads.status} not in ('WON','LOST')` : undefined,
      q.source ? eq(schema.leads.source, q.source) : undefined,
      q.ownerId === "none" ? isNull(schema.leads.ownerId) : q.ownerId ? eq(schema.leads.ownerId, q.ownerId) : undefined,
      q.tag ? sql`${schema.leads.tags} @> ${JSON.stringify([q.tag])}::jsonb` : undefined,
      term ? or(ilike(schema.leads.name, `%${term}%`), ilike(schema.leads.phone, `%${term.replace(/\D/g, "") || term}%`), ilike(schema.leads.interest, `%${term}%`)) : undefined,
    ),
    with: { owner: true, tasks: { where: isNull(schema.crmTasks.doneAt), orderBy: asc(schema.crmTasks.dueAt), limit: 1 } },
    orderBy: desc(schema.leads.createdAt),
    limit: 500,
  });
  const allTags = await db.execute(sql`select distinct jsonb_array_elements_text(tags) as tag from leads where clinic_id = ${clinicId} order by 1`);
  const sources = await db.selectDistinct({ s: schema.leads.source }).from(schema.leads).where(eq(schema.leads.clinicId, clinicId));
  res.json({
    leads: rows.map((l) => leadView(l, l.tasks[0])),
    tags: (allTags.rows as { tag: string }[]).map((r) => r.tag),
    sources: sources.map((s) => s.s).sort(),
  });
}));

crmRouter.post("/leads", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const b = z.object({
    name: z.string().min(1), phone: z.string(), email: z.string().email().optional().or(z.literal("")),
    interest: z.string().max(300).optional(), source: z.string().max(40).default("Other"), value: z.number().int().min(0).default(0),
    ownerId: z.string().nullish(), tags: z.array(z.string().max(30)).max(10).default([]), stage: stageSchema.default("NEW"),
  }).parse(req.body);
  const phone = normalizeUsPhone(b.phone);
  if (!phone) throw badRequest("Invalid phone number");
  const ownerId = await ownerInClinic(clinicId, b.ownerId);
  const lead = await createLead({
    clinicId, phone, name: b.name, email: b.email || null, interest: b.interest, source: b.source, value: b.value, ownerId,
    tags: b.tags, stage: b.stage, actor: await actorName(req.user!.id), userId: req.user!.id,
    task: { title: "First call", type: "CALL", dueInMinutes: 60 },
  });
  await audit(req, { action: "CRM_CREATE_CONTACT", entity: "lead", entityId: lead.id, clinicId });
  res.status(201).json(leadView(lead));
}));

crmRouter.get("/leads/:id", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const l = await db.query.leads.findFirst({
    where: and(eq(schema.leads.id, req.params.id), eq(schema.leads.clinicId, clinicId)),
    with: {
      owner: true,
      activities: { orderBy: desc(schema.crmActivities.createdAt), limit: 200 },
      tasks: { with: { owner: true }, orderBy: [asc(schema.crmTasks.doneAt), asc(schema.crmTasks.dueAt)] },
    },
  });
  if (!l) throw notFound("Contact not found");
  await audit(req, { action: "CRM_VIEW_CONTACT", entity: "lead", entityId: l.id, clinicId });
  res.json({
    ...leadView(l, l.tasks.find((t) => !t.doneAt)),
    activities: l.activities.map((a) => ({ id: a.id, type: a.type, text: decrypt(a.textEnc), actor: a.actor, createdAt: a.createdAt })),
    tasks: l.tasks.map((t) => ({ id: t.id, title: t.title, type: t.type, dueAt: t.dueAt, doneAt: t.doneAt, owner: t.owner ? { id: t.owner.id, name: t.owner.name } : null })),
  });
}));

crmRouter.patch("/leads/:id", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const b = z.object({
    name: z.string().min(1).optional(), email: z.string().email().nullable().optional().or(z.literal("")), interest: z.string().max(300).nullable().optional(),
    stage: stageSchema.optional(), value: z.number().int().min(0).optional(), ownerId: z.string().nullable().optional(),
    tags: z.array(z.string().max(30)).max(10).optional(), source: z.string().max(40).optional(),
  }).parse(req.body);
  let lead = await getLead(clinicId, req.params.id);
  const actor = await actorName(req.user!.id);
  if (b.stage) lead = await setStage(lead, b.stage, actor, req.user!.id);
  const { stage, ...rest } = b;
  if (rest.ownerId !== undefined) rest.ownerId = await ownerInClinic(clinicId, rest.ownerId);
  if (rest.email === "") rest.email = null;
  if (Object.keys(rest).length) {
    [lead] = await db.update(schema.leads).set(rest as any).where(eq(schema.leads.id, lead.id)).returning();
  }
  await audit(req, { action: "CRM_UPDATE_CONTACT", entity: "lead", entityId: lead.id, clinicId, meta: { fields: Object.keys(b) } });
  res.json(leadView(lead));
}));

crmRouter.post("/leads/:id/activities", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const b = z.object({ type: z.enum(["CALL", "SMS", "EMAIL", "NOTE"]), text: z.string().min(1).max(2000) }).parse(req.body);
  const lead = await getLead(clinicId, req.params.id);
  await logActivity(lead, b.type, b.text, await actorName(req.user!.id), req.user!.id);
  // Reaching out moves a new inquiry to "Contacted"
  if (lead.status === "NEW" && b.type !== "NOTE") await setStage(lead, "CONTACTED", await actorName(req.user!.id), req.user!.id);
  await audit(req, { action: "CRM_LOG_ACTIVITY", entity: "lead", entityId: lead.id, clinicId, meta: { type: b.type } });
  res.status(201).json({ ok: true });
}));

crmRouter.post("/leads/:id/tasks", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const b = z.object({ title: z.string().min(1).max(200), type: taskType.default("CALL"), dueAt: z.string().datetime({ offset: true }), ownerId: z.string().nullish() }).parse(req.body);
  const lead = await getLead(clinicId, req.params.id);
  const task = await addTask(lead, { title: b.title, type: b.type, dueAt: new Date(b.dueAt) }, await ownerInClinic(clinicId, b.ownerId) ?? lead.ownerId);
  res.status(201).json(task);
}));

// ---------------- tasks ----------------
crmRouter.get("/tasks", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const clinic = await getClinic(clinicId);
  const q = z.object({
    status: z.enum(["open", "today", "overdue", "done", "all"]).default("open"), ownerId: z.string().optional(), type: taskType.optional(),
  }).parse(req.query);
  const now = new Date();
  const endOfToday = DateTime.now().setZone(clinic.timezone).endOf("day").toJSDate();
  const T = schema.crmTasks;
  const rows = await db.query.crmTasks.findMany({
    where: and(
      eq(T.clinicId, clinicId),
      q.status === "open" ? isNull(T.doneAt) : undefined,
      q.status === "today" ? and(isNull(T.doneAt), lt(T.dueAt, endOfToday)) : undefined,
      q.status === "overdue" ? and(isNull(T.doneAt), lt(T.dueAt, now)) : undefined,
      q.status === "done" ? isNotNull(T.doneAt) : undefined,
      q.ownerId === "none" ? isNull(T.ownerId) : q.ownerId ? eq(T.ownerId, q.ownerId) : undefined,
      q.type ? eq(T.type, q.type) : undefined,
    ),
    with: { lead: true, owner: true },
    orderBy: [asc(T.doneAt), asc(T.dueAt)],
    limit: 500,
  });
  res.json(rows.map((t) => ({
    id: t.id, title: t.title, type: t.type, dueAt: t.dueAt, doneAt: t.doneAt, overdue: !t.doneAt && t.dueAt < now,
    owner: t.owner ? { id: t.owner.id, name: t.owner.name } : null,
    lead: { id: t.lead.id, name: t.lead.name, phone: t.lead.phone, stage: t.lead.status },
  })));
}));

crmRouter.patch("/tasks/:id", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const b = z.object({ done: z.boolean().optional(), title: z.string().min(1).max(200).optional(), dueAt: z.string().datetime({ offset: true }).optional(), ownerId: z.string().nullable().optional() }).parse(req.body);
  const task = await db.query.crmTasks.findFirst({ where: and(eq(schema.crmTasks.id, req.params.id), eq(schema.crmTasks.clinicId, clinicId)) });
  if (!task) throw notFound("Task not found");
  const set: any = {};
  if (b.done !== undefined) set.doneAt = b.done ? new Date() : null;
  if (b.title) set.title = b.title;
  if (b.dueAt) set.dueAt = new Date(b.dueAt);
  if (b.ownerId !== undefined) set.ownerId = await ownerInClinic(clinicId, b.ownerId);
  const [t] = await db.update(schema.crmTasks).set(set).where(eq(schema.crmTasks.id, task.id)).returning();
  if (b.done && !task.doneAt) await logActivity({ id: task.leadId, clinicId }, "TASK", `Task done: ${task.title}`, await actorName(req.user!.id), req.user!.id);
  res.json(t);
}));

// ---------------- people who can own leads/tasks ----------------
crmRouter.get("/owners", ah(async (req, res) => {
  const clinicId = clinicScope(req);
  const rows = await db.query.users.findMany({ where: and(eq(schema.users.clinicId, clinicId), eq(schema.users.active, true)), orderBy: asc(schema.users.name) });
  res.json(rows.map((u) => ({ id: u.id, name: u.name })));
}));
