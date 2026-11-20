CREATE TYPE "public"."appointment_status" AS ENUM('BOOKED', 'CONFIRMED', 'SHOWED', 'NO_SHOW', 'CANCELLED', 'RESCHEDULED');--> statement-breakpoint
CREATE TYPE "public"."booking_source" AS ENUM('AI_CALL', 'AI_OUTBOUND', 'SMS', 'STAFF');--> statement-breakpoint
CREATE TYPE "public"."call_direction" AS ENUM('INBOUND', 'OUTBOUND');--> statement-breakpoint
CREATE TYPE "public"."call_purpose" AS ENUM('RECEPTION', 'NO_SHOW_REBOOK', 'FEEDBACK');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('CALL', 'SMS');--> statement-breakpoint
CREATE TYPE "public"."crm_activity_type" AS ENUM('CALL', 'SMS', 'EMAIL', 'NOTE', 'APPT', 'STAGE', 'TASK', 'CREATED');--> statement-breakpoint
CREATE TYPE "public"."crm_task_type" AS ENUM('CALL', 'TEXT', 'EMAIL', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('NEW', 'CONTACTED', 'APPT', 'PLAN', 'WON', 'LOST');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('SUPER_ADMIN', 'CLINIC_OWNER', 'CLINIC_STAFF');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('PENDING', 'IN_PROGRESS', 'DONE', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"provider_id" text,
	"service_id" text,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"status" "appointment_status" DEFAULT 'BOOKED' NOT NULL,
	"source" "booking_source" DEFAULT 'STAFF' NOT NULL,
	"reason" text,
	"reminder_sent_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"status_changed_at" timestamp with time zone,
	"rescheduled_from_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"clinic_id" text,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity" text,
	"entity_id" text,
	"ip" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"patient_id" text,
	"appointment_id" text,
	"task_id" text,
	"plivo_call_uuid" text,
	"direction" "call_direction" NOT NULL,
	"purpose" "call_purpose" DEFAULT 'RECEPTION' NOT NULL,
	"from_number" text NOT NULL,
	"to_number" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_sec" integer,
	"outcome" text,
	"summary_enc" text,
	"transcript_enc" text
);
--> statement-breakpoint
CREATE TABLE "clinics" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"ai_phone_number" text NOT NULL,
	"transfer_number" text,
	"timezone" text DEFAULT 'America/Chicago' NOT NULL,
	"address" text,
	"website" text,
	"business_hours" jsonb NOT NULL,
	"slot_minutes" integer DEFAULT 30 NOT NULL,
	"ai_enabled" boolean DEFAULT true NOT NULL,
	"ai_greeting" text,
	"ai_extra_instructions" text,
	"sms_enabled" boolean DEFAULT true NOT NULL,
	"reminder_hours_before" integer DEFAULT 24 NOT NULL,
	"no_show_follow_up" boolean DEFAULT true NOT NULL,
	"no_show_delay_minutes" integer DEFAULT 120 NOT NULL,
	"auto_no_show_after_minutes" integer,
	"feedback_enabled" boolean DEFAULT true NOT NULL,
	"feedback_channel" "channel" DEFAULT 'CALL' NOT NULL,
	"feedback_delay_minutes" integer DEFAULT 180 NOT NULL,
	"calling_hours_start" text DEFAULT '09:00' NOT NULL,
	"calling_hours_end" text DEFAULT '19:00' NOT NULL,
	"daily_report_time" text DEFAULT '19:00' NOT NULL,
	"last_daily_report_date" text,
	"task_digest_time" text DEFAULT '09:00' NOT NULL,
	"last_task_digest_date" text,
	"retention_days" integer DEFAULT 90 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinics_ai_phone_number_unique" UNIQUE("ai_phone_number")
);
--> statement-breakpoint
CREATE TABLE "crm_activities" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"lead_id" text NOT NULL,
	"type" "crm_activity_type" NOT NULL,
	"text_enc" text,
	"actor" text NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"lead_id" text NOT NULL,
	"title" text NOT NULL,
	"type" "crm_task_type" DEFAULT 'CALL' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"owner_id" text,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"appointment_id" text,
	"rating" integer,
	"comment_enc" text,
	"channel" "channel" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"patient_id" text,
	"name" text,
	"phone" text NOT NULL,
	"email" text,
	"interest" text,
	"status" "lead_status" DEFAULT 'NEW' NOT NULL,
	"source" text DEFAULT 'AI call' NOT NULL,
	"value" integer DEFAULT 0 NOT NULL,
	"owner_id" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"appointment_id" text,
	"purpose" "call_purpose" NOT NULL,
	"channel" "channel" DEFAULT 'CALL' NOT NULL,
	"status" "task_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 2 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patients" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"phone" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"email" text,
	"is_new" boolean DEFAULT true NOT NULL,
	"sms_consent" boolean DEFAULT false NOT NULL,
	"call_consent" boolean DEFAULT false NOT NULL,
	"sms_opt_out" boolean DEFAULT false NOT NULL,
	"notes_enc" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"platform" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"name" text NOT NULL,
	"duration_min" integer DEFAULT 30 NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"refresh_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_refresh_hash_unique" UNIQUE("refresh_hash")
);
--> statement-breakpoint
CREATE TABLE "sms_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"patient_id" text,
	"direction" text NOT NULL,
	"from_number" text NOT NULL,
	"to_number" text NOT NULL,
	"body_enc" text NOT NULL,
	"purpose" text,
	"provider_message_id" text,
	"status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "role" NOT NULL,
	"totp_secret_enc" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD CONSTRAINT "crm_tasks_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD CONSTRAINT "crm_tasks_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD CONSTRAINT "crm_tasks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_tasks" ADD CONSTRAINT "outbound_tasks_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_tasks" ADD CONSTRAINT "outbound_tasks_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_tasks" ADD CONSTRAINT "outbound_tasks_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointments_clinic_start" ON "appointments" USING btree ("clinic_id","start_at");--> statement-breakpoint
CREATE INDEX "audit_clinic_created" ON "audit_logs" USING btree ("clinic_id","created_at");--> statement-breakpoint
CREATE INDEX "calls_clinic_started" ON "calls" USING btree ("clinic_id","started_at");--> statement-breakpoint
CREATE INDEX "crm_activities_lead" ON "crm_activities" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX "crm_tasks_clinic_due" ON "crm_tasks" USING btree ("clinic_id","due_at");--> statement-breakpoint
CREATE INDEX "leads_clinic_status" ON "leads" USING btree ("clinic_id","status");--> statement-breakpoint
CREATE INDEX "notifications_clinic_created" ON "notifications" USING btree ("clinic_id","created_at");--> statement-breakpoint
CREATE INDEX "tasks_status_next" ON "outbound_tasks" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "patients_clinic_phone" ON "patients" USING btree ("clinic_id","phone");