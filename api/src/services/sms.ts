import { config } from "../config";
import { db, schema } from "../db";
import type { Clinic, Patient } from "../db/schema";
import { encrypt } from "../lib/crypto";
import { maskPhone } from "../lib/phone";

import { sendMessage } from "../lib/plivo";

export type SmsPurpose = "REMINDER" | "CONFIRMED" | "FEEDBACK_REQUEST" | "NO_SHOW" | "OPT_OUT" | "REPLY" | "BOOKED";

const OPT_OUT_FOOTER = " Reply STOP to opt out.";

/**
 * Send an SMS to a patient.
 *  - Requires patient SMS consent and no opt-out (TCPA).
 *  - Keep text to the minimum necessary (HIPAA): clinic name + date/time. No treatment details.
 *  - Body is stored encrypted.
 */
export async function sendSms(
  clinic: Clinic,
  patient: Patient,
  text: string,
  purpose: SmsPurpose,
  opts: { skipConsentCheck?: boolean } = {},
): Promise<{ sent: boolean; reason?: string }> {
  if (!clinic.smsEnabled) return { sent: false, reason: "SMS disabled for clinic" };
  if (patient.smsOptOut && purpose !== "OPT_OUT") return { sent: false, reason: "Patient opted out" };
  if (!opts.skipConsentCheck && !patient.smsConsent) return { sent: false, reason: "No SMS consent" };

  const body = purpose === "OPT_OUT" || purpose === "REPLY" ? text : text + OPT_OUT_FOOTER;
  let providerMessageId: string | null = null;
  let status = "queued";

  if (config.dryRun) {
    console.log(`[sms:dry-run] to ${maskPhone(patient.phone)} (${purpose})`);
    status = "dry_run";
  } else {
    try {
      providerMessageId = await sendMessage(clinic.aiPhoneNumber, patient.phone, body, {
        url: `${config.publicApiUrl}/webhooks/plivo/sms-status`,
        // log=false: Plivo does not keep the text and masks the number in its logs (we keep our own encrypted copy)
        log: config.plivo.redactSms ? false : undefined,
      });
    } catch (e) {
      console.error(`[sms] failed to ${maskPhone(patient.phone)}:`, (e as Error).message);
      status = "failed";
    }
  }

  await db.insert(schema.smsMessages).values({
    clinicId: clinic.id,
    patientId: patient.id,
    direction: "OUT",
    fromNumber: clinic.aiPhoneNumber,
    toNumber: patient.phone,
    bodyEnc: encrypt(body)!,
    purpose,
    providerMessageId,
    status,
  });
  return { sent: status !== "failed", reason: status === "failed" ? "Provider error" : undefined };
}
