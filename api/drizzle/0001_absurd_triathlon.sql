CREATE TYPE "public"."patient_link_purpose" AS ENUM('BOOKED', 'REMINDER', 'CONFIRMED');--> statement-breakpoint
CREATE TYPE "public"."sms_style" AS ENUM('FULL', 'LINK');--> statement-breakpoint
CREATE TABLE "patient_links" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"appointment_id" text,
	"purpose" "patient_link_purpose" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"session_hash" text,
	"session_expires_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "sms_style" "sms_style" DEFAULT 'LINK' NOT NULL;--> statement-breakpoint
ALTER TABLE "patient_links" ADD CONSTRAINT "patient_links_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_links" ADD CONSTRAINT "patient_links_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_links" ADD CONSTRAINT "patient_links_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patient_links_patient" ON "patient_links" USING btree ("patient_id");