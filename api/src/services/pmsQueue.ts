// Fire-and-forget hand-off to the PMS sync, so a slow or offline Open Dental never delays a phone call.
// Anything that fails here is retried by the sync job (appointments with pmsSyncedAt = null).
import type { Clinic } from "../db/schema";
import { config } from "../config";

export function queuePmsPush(clinic: Pick<Clinic, "id" | "pmsType">, appointmentId: string, replacedId?: string) {
  if (clinic.pmsType === "NONE" || !config.openDental.developerKey || process.env.PMS_SYNC_INLINE === "false") return;
  setImmediate(() => {
    import("./pms")
      .then((m) => m.pushAppointment(clinic.id, appointmentId, replacedId))
      .catch((e) => console.error("[pms] push failed", (e as Error).message));
  });
}
