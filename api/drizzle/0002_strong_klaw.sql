CREATE TYPE "public"."billing_status" AS ENUM('TRIAL', 'MANUAL', 'ACTIVE', 'PAST_DUE', 'CANCELED');--> statement-breakpoint
CREATE TYPE "public"."plan" AS ENUM('STARTER', 'GROWTH', 'PRO');--> statement-breakpoint
CREATE TYPE "public"."pms_type" AS ENUM('NONE', 'OPEN_DENTAL');--> statement-breakpoint
CREATE TABLE "clinic_numbers" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"number" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinic_numbers_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "pms_busy_blocks" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"pms_apt_num" integer NOT NULL,
	"provider_id" text,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_periods" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"period" text NOT NULL,
	"minutes" integer DEFAULT 0 NOT NULL,
	"included_minutes" integer DEFAULT 0 NOT NULL,
	"overage_minutes" integer DEFAULT 0 NOT NULL,
	"overage_cents" integer DEFAULT 0 NOT NULL,
	"invoiced_at" timestamp with time zone,
	"stripe_invoice_item_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "pms_apt_num" integer;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "pms_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "pms_error" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "verified_patient_id" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "verify_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "plan" "plan" DEFAULT 'GROWTH' NOT NULL;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "minutes_included" integer;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "overage_cents_per_min" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "billing_status" "billing_status" DEFAULT 'TRIAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "billing_email" text;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "usage_alert_period" text;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "pms_type" "pms_type" DEFAULT 'NONE' NOT NULL;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "pms_customer_key_enc" text;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "pms_clinic_num" integer;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "pms_operatory_num" integer;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "pms_provider_map" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "pms_last_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "pms_sync_error" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "call_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "call_consent_source" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "call_opt_out" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "dob_hash" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "dob_enc" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "insurance_enc" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "pms_pat_num" integer;--> statement-breakpoint
ALTER TABLE "clinic_numbers" ADD CONSTRAINT "clinic_numbers_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pms_busy_blocks" ADD CONSTRAINT "pms_busy_blocks_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_periods" ADD CONSTRAINT "usage_periods_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pms_busy_clinic_apt" ON "pms_busy_blocks" USING btree ("clinic_id","pms_apt_num");--> statement-breakpoint
CREATE INDEX "pms_busy_clinic_start" ON "pms_busy_blocks" USING btree ("clinic_id","start_at");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_clinic_period" ON "usage_periods" USING btree ("clinic_id","period");