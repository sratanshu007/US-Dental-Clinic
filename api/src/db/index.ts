import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config";
import * as schema from "./schema";

export const pool = new Pool({
  connectionString: config.databaseUrl,
  // Production databases must use TLS (HIPAA: encryption in transit).
  ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined,
  max: Number(process.env.DB_POOL_MAX ?? 20),
  // Fail fast instead of hanging a phone call if the pool is ever exhausted
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
});

export const db = drizzle(pool, { schema });
export { schema };

// Auto-align new schema columns on database connect
async function runAutoMigrations() {
  try {
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'plan') THEN
          CREATE TYPE plan AS ENUM ('STARTER', 'GROWTH', 'PRO');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'billing_status') THEN
          CREATE TYPE billing_status AS ENUM ('TRIAL', 'MANUAL', 'ACTIVE', 'PAST_DUE', 'CANCELED');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pms_type') THEN
          CREATE TYPE pms_type AS ENUM ('NONE', 'OPEN_DENTAL');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'patient_link_purpose') THEN
          CREATE TYPE patient_link_purpose AS ENUM ('BOOKED', 'REMINDER', 'CONFIRMED');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'sms_style') THEN
          CREATE TYPE sms_style AS ENUM ('FULL', 'LINK');
        END IF;
      END $$;

      ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_logins integer NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until timestamptz;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;

      ALTER TABLE clinics ADD COLUMN IF NOT EXISTS sms_style sms_style NOT NULL DEFAULT 'LINK';
      ALTER TABLE clinics ADD COLUMN IF NOT EXISTS sms_only_booked boolean NOT NULL DEFAULT true;
      ALTER TABLE clinics ADD COLUMN IF NOT EXISTS plan plan NOT NULL DEFAULT 'GROWTH';
      ALTER TABLE clinics ADD COLUMN IF NOT EXISTS minutes_included integer;
      ALTER TABLE clinics ADD COLUMN IF NOT EXISTS overage_cents_per_min integer NOT NULL DEFAULT 15;
      ALTER TABLE clinics ADD COLUMN IF NOT EXISTS billing_status billing_status NOT NULL DEFAULT 'TRIAL';
      ALTER TABLE clinics ADD COLUMN IF NOT EXISTS billing_email text;
      ALTER TABLE clinics ADD COLUMN IF NOT EXISTS stripe_customer_id text;
      ALTER TABLE clinics ADD COLUMN IF NOT EXISTS stripe_subscription_id text;
      ALTER TABLE clinics ADD COLUMN IF NOT EXISTS usage_alert_period text;
      ALTER TABLE clinics ADD COLUMN IF NOT EXISTS pms_type pms_type NOT NULL DEFAULT 'NONE';
      ALTER TABLE clinics ADD COLUMN IF NOT EXISTS pms_customer_key_enc text;
      ALTER TABLE clinics ADD COLUMN IF NOT EXISTS pms_clinic_num integer;
      ALTER TABLE clinics ADD COLUMN IF NOT EXISTS pms_operatory_num integer;
      ALTER TABLE clinics ADD COLUMN IF NOT EXISTS pms_provider_map jsonb NOT NULL DEFAULT '{}';
      ALTER TABLE clinics ADD COLUMN IF NOT EXISTS pms_last_sync_at timestamptz;
      ALTER TABLE clinics ADD COLUMN IF NOT EXISTS pms_sync_error text;

      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS pms_apt_num integer;
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS pms_synced_at timestamptz;
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS pms_error text;

      ALTER TABLE calls ADD COLUMN IF NOT EXISTS verified_patient_id text;
      ALTER TABLE calls ADD COLUMN IF NOT EXISTS verified_at timestamptz;
      ALTER TABLE calls ADD COLUMN IF NOT EXISTS verify_attempts integer NOT NULL DEFAULT 0;

      ALTER TABLE patients ADD COLUMN IF NOT EXISTS call_consent_at timestamptz;
      ALTER TABLE patients ADD COLUMN IF NOT EXISTS call_consent_source text;
      ALTER TABLE patients ADD COLUMN IF NOT EXISTS call_opt_out boolean NOT NULL DEFAULT false;
      ALTER TABLE patients ADD COLUMN IF NOT EXISTS dob_hash text;
      ALTER TABLE patients ADD COLUMN IF NOT EXISTS dob_enc text;
      ALTER TABLE patients ADD COLUMN IF NOT EXISTS insurance_enc text;
      ALTER TABLE patients ADD COLUMN IF NOT EXISTS pms_pat_num integer;

      CREATE TABLE IF NOT EXISTS patient_links (
        id text PRIMARY KEY NOT NULL,
        clinic_id text NOT NULL REFERENCES clinics(id),
        patient_id text NOT NULL REFERENCES patients(id),
        appointment_id text REFERENCES appointments(id),
        purpose patient_link_purpose NOT NULL,
        token_hash text NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        failed_attempts integer DEFAULT 0 NOT NULL,
        locked_at timestamptz,
        session_hash text,
        session_expires_at timestamptz,
        opened_at timestamptz,
        verified_at timestamptz,
        created_at timestamptz DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS clinic_numbers (
        id text PRIMARY KEY NOT NULL,
        clinic_id text NOT NULL REFERENCES clinics(id),
        number text NOT NULL UNIQUE,
        label text,
        created_at timestamptz DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pms_busy_blocks (
        id text PRIMARY KEY NOT NULL,
        clinic_id text NOT NULL REFERENCES clinics(id),
        pms_apt_num integer NOT NULL,
        provider_id text,
        start_at timestamptz NOT NULL,
        end_at timestamptz NOT NULL,
        updated_at timestamptz DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_periods (
        id text PRIMARY KEY NOT NULL,
        clinic_id text NOT NULL REFERENCES clinics(id),
        period text NOT NULL,
        minutes integer DEFAULT 0 NOT NULL,
        included_minutes integer DEFAULT 0 NOT NULL,
        overage_minutes integer DEFAULT 0 NOT NULL,
        overage_cents integer DEFAULT 0 NOT NULL,
        invoiced_at timestamptz,
        stripe_invoice_item_id text,
        created_at timestamptz DEFAULT now() NOT NULL
      );
    `);
    console.log("[db:migration:auto] Schema successfully synchronized.");
  } catch (err: any) {
    console.error("[db:migration:auto] Error synchronizing schema:", err.message);
  }
}

runAutoMigrations();
