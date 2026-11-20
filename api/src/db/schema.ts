// Dental AI Receptionist — database schema (Drizzle ORM, PostgreSQL)
//
// HIPAA notes:
//  * Run PostgreSQL with encryption at rest (e.g. AWS RDS encrypted, under a signed AWS BAA).
//  * Free-text fields that may hold health details (notes, transcripts, summaries, feedback,
//    SMS bodies) are additionally encrypted in the app (AES-256-GCM) — columns ending in "Enc".

import { createId } from "@paralleldrive/cuid2";
import {
  pgTable, pgEnum, text, integer, boolean, timestamp, jsonb, index, uniqueIndex,
} from "drizzle-orm/pg-core";

const id = () => text("id").primaryKey().$defaultFn(() => createId());
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date());

export const roleEnum = pgEnum("role", ["SUPER_ADMIN", "CLINIC_OWNER", "CLINIC_STAFF"]);
export const apptStatusEnum = pgEnum("appointment_status", [
  "BOOKED", "CONFIRMED", "SHOWED", "NO_SHOW", "CANCELLED", "RESCHEDULED",
]);
export const bookingSourceEnum = pgEnum("booking_source", ["AI_CALL", "AI_OUTBOUND", "SMS", "STAFF"]);
export const callDirectionEnum = pgEnum("call_direction", ["INBOUND", "OUTBOUND"]);
export const callPurposeEnum = pgEnum("call_purpose", ["RECEPTION", "NO_SHOW_REBOOK", "FEEDBACK"]);
export const taskStatusEnum = pgEnum("task_status", ["PENDING", "IN_PROGRESS", "DONE", "FAILED", "CANCELLED"]);
// CRM pipeline stages
export const leadStatusEnum = pgEnum("lead_status", ["NEW", "CONTACTED", "APPT", "PLAN", "WON", "LOST"]);
export const crmActivityEnum = pgEnum("crm_activity_type", ["CALL", "SMS", "EMAIL", "NOTE", "APPT", "STAGE", "TASK", "CREATED"]);
export const crmTaskTypeEnum = pgEnum("crm_task_type", ["CALL", "TEXT", "EMAIL", "OTHER"]);
export const channelEnum = pgEnum("channel", ["CALL", "SMS"]);

/** { mon: [["09:00","17:00"]], tue: [...], ... } — an empty list means closed that day. */
export type BusinessHours = Record<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun", [string, string][]>;

export const clinics = pgTable("clinics", {
  id: id(),
  name: text("name").notNull(),
  aiPhoneNumber: text("ai_phone_number").notNull().unique(), // Plivo number, E.164
  transferNumber: text("transfer_number"), // staff line for live transfer / emergencies
  timezone: text("timezone").notNull().default("America/Chicago"),
  address: text("address"),
  website: text("website"),
  businessHours: jsonb("business_hours").$type<BusinessHours>().notNull(),
  slotMinutes: integer("slot_minutes").notNull().default(30),
  aiEnabled: boolean("ai_enabled").notNull().default(true),
  aiGreeting: text("ai_greeting"),
  aiExtraInstructions: text("ai_extra_instructions"), // insurance, parking, pricing policy...
  smsEnabled: boolean("sms_enabled").notNull().default(true),
  reminderHoursBefore: integer("reminder_hours_before").notNull().default(24),
  noShowFollowUp: boolean("no_show_follow_up").notNull().default(true),
  noShowDelayMinutes: integer("no_show_delay_minutes").notNull().default(120),
  autoNoShowAfterMinutes: integer("auto_no_show_after_minutes"), // null = staff marks manually
  feedbackEnabled: boolean("feedback_enabled").notNull().default(true),
  feedbackChannel: channelEnum("feedback_channel").notNull().default("CALL"),
  feedbackDelayMinutes: integer("feedback_delay_minutes").notNull().default(180),
  callingHoursStart: text("calling_hours_start").notNull().default("09:00"),
  callingHoursEnd: text("calling_hours_end").notNull().default("19:00"),
  dailyReportTime: text("daily_report_time").notNull().default("19:00"),
  lastDailyReportDate: text("last_daily_report_date"),
  taskDigestTime: text("task_digest_time").notNull().default("09:00"),
  lastTaskDigestDate: text("last_task_digest_date"),
  retentionDays: integer("retention_days").notNull().default(90),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable("users", {
  id: id(),
  clinicId: text("clinic_id").references(() => clinics.id),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: roleEnum("role").notNull(),
  totpSecretEnc: text("totp_secret_enc"),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  active: boolean("active").notNull().default(true),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const sessions = pgTable("sessions", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  refreshHash: text("refresh_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  ip: text("ip"),
  userAgent: text("user_agent"),
  createdAt: createdAt(),
});

export const pushTokens = pgTable("push_tokens", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  platform: text("platform"),
  createdAt: createdAt(),
});

export const providers = pgTable("providers", {
  id: id(),
  clinicId: text("clinic_id").notNull().references(() => clinics.id),
  name: text("name").notNull(),
  title: text("title"),
  active: boolean("active").notNull().default(true),
});

export const services = pgTable("services", {
  id: id(),
  clinicId: text("clinic_id").notNull().references(() => clinics.id),
  name: text("name").notNull(),
  durationMin: integer("duration_min").notNull().default(30),
  description: text("description"),
  active: boolean("active").notNull().default(true),
});

export const patients = pgTable("patients", {
  id: id(),
  clinicId: text("clinic_id").notNull().references(() => clinics.id),
  phone: text("phone").notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  email: text("email"),
  isNew: boolean("is_new").notNull().default(true),
  smsConsent: boolean("sms_consent").notNull().default(false),
  callConsent: boolean("call_consent").notNull().default(false),
  smsOptOut: boolean("sms_opt_out").notNull().default(false),
  notesEnc: text("notes_enc"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("patients_clinic_phone").on(t.clinicId, t.phone)]);

export const appointments = pgTable("appointments", {
  id: id(),
  clinicId: text("clinic_id").notNull().references(() => clinics.id),
  patientId: text("patient_id").notNull().references(() => patients.id),
  providerId: text("provider_id").references(() => providers.id),
  serviceId: text("service_id").references(() => services.id),
  startAt: timestamp("start_at", { withTimezone: true }).notNull(),
  endAt: timestamp("end_at", { withTimezone: true }).notNull(),
  status: apptStatusEnum("status").notNull().default("BOOKED"),
  source: bookingSourceEnum("source").notNull().default("STAFF"),
  reason: text("reason"),
  reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
  rescheduledFromId: text("rescheduled_from_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("appointments_clinic_start").on(t.clinicId, t.startAt)]);

export const calls = pgTable("calls", {
  id: id(),
  clinicId: text("clinic_id").notNull().references(() => clinics.id),
  patientId: text("patient_id").references(() => patients.id),
  appointmentId: text("appointment_id").references(() => appointments.id),
  taskId: text("task_id"),
  plivoCallUuid: text("plivo_call_uuid"),
  direction: callDirectionEnum("direction").notNull(),
  purpose: callPurposeEnum("purpose").notNull().default("RECEPTION"),
  fromNumber: text("from_number").notNull(),
  toNumber: text("to_number").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  durationSec: integer("duration_sec"),
  outcome: text("outcome"), // BOOKED, RESCHEDULED, CANCELLED, INFO, LEAD, TRANSFERRED, FEEDBACK, NO_ANSWER
  summaryEnc: text("summary_enc"),
  transcriptEnc: text("transcript_enc"),
}, (t) => [index("calls_clinic_started").on(t.clinicId, t.startedAt)]);

/** CRM contact / deal. Every AI inquiry lands here. */
export const leads = pgTable("leads", {
  id: id(),
  clinicId: text("clinic_id").notNull().references(() => clinics.id),
  patientId: text("patient_id").references(() => patients.id),
  name: text("name"),
  phone: text("phone").notNull(),
  email: text("email"),
  interest: text("interest"),
  status: leadStatusEnum("status").notNull().default("NEW"),
  source: text("source").notNull().default("AI call"), // AI call, AI SMS, Website, Google Ads, Referral, Walk-in, Other
  value: integer("value").notNull().default(0), // estimated deal value in USD
  ownerId: text("owner_id").references(() => users.id),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("leads_clinic_status").on(t.clinicId, t.status)]);

export const crmActivities = pgTable("crm_activities", {
  id: id(),
  clinicId: text("clinic_id").notNull().references(() => clinics.id),
  leadId: text("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  type: crmActivityEnum("type").notNull(),
  textEnc: text("text_enc"), // may contain health details -> encrypted
  actor: text("actor").notNull(), // user name, "AI receptionist", "system"
  userId: text("user_id"),
  createdAt: createdAt(),
}, (t) => [index("crm_activities_lead").on(t.leadId, t.createdAt)]);

export const crmTasks = pgTable("crm_tasks", {
  id: id(),
  clinicId: text("clinic_id").notNull().references(() => clinics.id),
  leadId: text("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  type: crmTaskTypeEnum("type").notNull().default("CALL"),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  ownerId: text("owner_id").references(() => users.id),
  doneAt: timestamp("done_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index("crm_tasks_clinic_due").on(t.clinicId, t.dueAt)]);

export const feedback = pgTable("feedback", {
  id: id(),
  clinicId: text("clinic_id").notNull().references(() => clinics.id),
  patientId: text("patient_id").notNull().references(() => patients.id),
  appointmentId: text("appointment_id").references(() => appointments.id),
  rating: integer("rating"),
  commentEnc: text("comment_enc"),
  channel: channelEnum("channel").notNull(),
  createdAt: createdAt(),
});

export const smsMessages = pgTable("sms_messages", {
  id: id(),
  clinicId: text("clinic_id").notNull().references(() => clinics.id),
  patientId: text("patient_id").references(() => patients.id),
  direction: text("direction").notNull(), // OUT | IN
  fromNumber: text("from_number").notNull(),
  toNumber: text("to_number").notNull(),
  bodyEnc: text("body_enc").notNull(),
  purpose: text("purpose"), // REMINDER, CONFIRMED, FEEDBACK_REQUEST, OPT_OUT, NO_SHOW, REPLY
  providerMessageId: text("provider_message_id"),
  status: text("status"),
  createdAt: createdAt(),
});

export const outboundTasks = pgTable("outbound_tasks", {
  id: id(),
  clinicId: text("clinic_id").notNull().references(() => clinics.id),
  patientId: text("patient_id").notNull().references(() => patients.id),
  appointmentId: text("appointment_id").references(() => appointments.id),
  purpose: callPurposeEnum("purpose").notNull(),
  channel: channelEnum("channel").notNull().default("CALL"),
  status: taskStatusEnum("status").notNull().default("PENDING"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(2),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
  lastError: text("last_error"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("tasks_status_next").on(t.status, t.nextAttemptAt)]);

export const notifications = pgTable("notifications", {
  id: id(),
  clinicId: text("clinic_id").notNull().references(() => clinics.id),
  type: text("type").notNull(), // NEW_BOOKING, NEW_LEAD, DAILY_REPORT, NO_SHOW, FEEDBACK, TRANSFER
  title: text("title").notNull(), // never contains PHI
  body: text("body").notNull(), // never contains PHI
  link: text("link"),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index("notifications_clinic_created").on(t.clinicId, t.createdAt)]);

export const auditLogs = pgTable("audit_logs", {
  id: id(),
  userId: text("user_id"),
  clinicId: text("clinic_id"),
  actor: text("actor").notNull(), // user email | voice-agent | system | plivo
  action: text("action").notNull(),
  entity: text("entity"),
  entityId: text("entity_id"),
  ip: text("ip"),
  meta: jsonb("meta"),
  createdAt: createdAt(),
}, (t) => [index("audit_clinic_created").on(t.clinicId, t.createdAt)]);

export type Clinic = typeof clinics.$inferSelect;
export type User = typeof users.$inferSelect;
export type Patient = typeof patients.$inferSelect;
export type Appointment = typeof appointments.$inferSelect;
export type Lead = typeof leads.$inferSelect;

// ---------------- relations (for db.query ... with) ----------------
import { relations } from "drizzle-orm";

export const clinicsRelations = relations(clinics, ({ many }) => ({
  users: many(users), providers: many(providers), services: many(services), patients: many(patients),
}));
export const usersRelations = relations(users, ({ one, many }) => ({
  clinic: one(clinics, { fields: [users.clinicId], references: [clinics.id] }),
  sessions: many(sessions), pushTokens: many(pushTokens),
}));
export const sessionsRelations = relations(sessions, ({ one }) => ({ user: one(users, { fields: [sessions.userId], references: [users.id] }) }));
export const pushTokensRelations = relations(pushTokens, ({ one }) => ({ user: one(users, { fields: [pushTokens.userId], references: [users.id] }) }));
export const providersRelations = relations(providers, ({ one }) => ({ clinic: one(clinics, { fields: [providers.clinicId], references: [clinics.id] }) }));
export const servicesRelations = relations(services, ({ one }) => ({ clinic: one(clinics, { fields: [services.clinicId], references: [clinics.id] }) }));
export const patientsRelations = relations(patients, ({ one, many }) => ({
  clinic: one(clinics, { fields: [patients.clinicId], references: [clinics.id] }),
  appointments: many(appointments), calls: many(calls), feedback: many(feedback), leads: many(leads),
}));
export const appointmentsRelations = relations(appointments, ({ one }) => ({
  clinic: one(clinics, { fields: [appointments.clinicId], references: [clinics.id] }),
  patient: one(patients, { fields: [appointments.patientId], references: [patients.id] }),
  provider: one(providers, { fields: [appointments.providerId], references: [providers.id] }),
  service: one(services, { fields: [appointments.serviceId], references: [services.id] }),
}));
export const callsRelations = relations(calls, ({ one }) => ({
  patient: one(patients, { fields: [calls.patientId], references: [patients.id] }),
  appointment: one(appointments, { fields: [calls.appointmentId], references: [appointments.id] }),
}));
export const leadsRelations = relations(leads, ({ one, many }) => ({
  patient: one(patients, { fields: [leads.patientId], references: [patients.id] }),
  owner: one(users, { fields: [leads.ownerId], references: [users.id] }),
  activities: many(crmActivities),
  tasks: many(crmTasks),
}));
export const crmActivitiesRelations = relations(crmActivities, ({ one }) => ({ lead: one(leads, { fields: [crmActivities.leadId], references: [leads.id] }) }));
export const crmTasksRelations = relations(crmTasks, ({ one }) => ({
  lead: one(leads, { fields: [crmTasks.leadId], references: [leads.id] }),
  owner: one(users, { fields: [crmTasks.ownerId], references: [users.id] }),
}));
export const feedbackRelations = relations(feedback, ({ one }) => ({
  patient: one(patients, { fields: [feedback.patientId], references: [patients.id] }),
  appointment: one(appointments, { fields: [feedback.appointmentId], references: [appointments.id] }),
}));
export const outboundTasksRelations = relations(outboundTasks, ({ one }) => ({
  clinic: one(clinics, { fields: [outboundTasks.clinicId], references: [clinics.id] }),
  patient: one(patients, { fields: [outboundTasks.patientId], references: [patients.id] }),
  appointment: one(appointments, { fields: [outboundTasks.appointmentId], references: [appointments.id] }),
}));
