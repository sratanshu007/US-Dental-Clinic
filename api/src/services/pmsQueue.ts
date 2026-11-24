// Fire-and-forget hand-off to the PMS sync, so a slow or offline Open Dental never delays a phone call.
// Anything that fails here is retried by the sync job (appointments with pmsSyncedAt = null).
import type { Clinic } from "../db/schema";

export function queuePmsPush(_clinic: Pick<Clinic, "id" | "pmsType">, _appointmentId: string, _replacedId?: string) {
  // PMS sync disabled — using internal clinic calendar
  return;
}
