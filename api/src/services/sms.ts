import * as plivo from "plivo";
import { config } from "../config";
import { db, schema } from "../db";
import type { Clinic, Patient } from "../db/schema";
import { encrypt } from "../lib/crypto";
import { maskPhone } from "../lib/phone";

let client: plivo.Client | null = null;
function plivoClient() {
  if (!client) client = new plivo.Client(config.plivo.authId, config.plivo.authToken);
  return client;
}

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
      const res = await plivoClient().messages.create(clinic.aiPhoneNumber, patient.phone, body, {
        url: `${config.publicApiUrl}/webhooks/plivo/sms-status`,
        // log=false: Plivo does not keep the text and masks the number in its logs (we keep our own encrypted copy)
        ...(config.plivo.redactSms ? { log: false } : {}),
      } as Record<string, unknown>);
      providerMessageId = (res as { messageUuid?: string[] }).messageUuid?.[0] ?? null;
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

/**
 * Automatically wire a clinic's number in Plivo:
 * Creates/updates the "Dental AI Receptionist" Application with webhooks
 * and attaches the number to it.
 */
export async function syncPlivoNumber(phoneNumber: string): Promise<void> {
  if (!config.plivo.authId || !config.plivo.authToken) return;
  const digits = phoneNumber.replace(/\D/g, "");
  if (!digits || digits.length < 10) return;

  try {
    const pc = plivoClient();
    const voiceUrl = process.env.PUBLIC_VOICE_URL || config.voiceAgentUrl;
    const answerUrl = `${voiceUrl.replace(/\/$/, "")}/plivo/answer`;
    const hangupUrl = `${voiceUrl.replace(/\/$/, "")}/plivo/hangup`;
    const messageUrl = `${config.publicApiUrl.replace(/\/$/, "")}/webhooks/plivo/sms`;

    // 1. Find or create the Application
    const appsRes: any = await pc.applications.list();
    const apps: any[] = appsRes.objects || (Array.isArray(appsRes) ? appsRes : []);
    let app = apps.find((a: any) => a.appName === "Dental AI Receptionist" || a.app_name === "Dental AI Receptionist");

    let appId = "";
    if (app) {
      appId = app.appId || app.app_id;
      await (pc.applications as any).update(appId, {
        answerUrl,
        answerMethod: "POST",
        hangupUrl,
        hangupMethod: "POST",
        messageUrl,
        messageMethod: "POST",
      });
    } else {
      const created: any = await (pc.applications as any).create("Dental AI Receptionist", {
        answerUrl,
        answerMethod: "POST",
        hangupUrl,
        hangupMethod: "POST",
        messageUrl,
        messageMethod: "POST",
      });
      appId = created.appId || created.app_id;
    }

    // 2. Attach the number to this Application
    if (appId) {
      await pc.numbers.update(digits, { appId });
      console.log(`[plivo] Auto-wired number +${digits} to Plivo Application (${appId})`);
    }
  } catch (err: any) {
    // Non-blocking notice (e.g. if test numbers like +12105550100 are not owned on Plivo)
    console.warn(`[plivo] Notice for +${digits}: ${(err as Error).message}`);
  }
}
