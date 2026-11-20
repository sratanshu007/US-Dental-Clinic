import type { Request } from "express";
import { db, schema } from "../db";

export interface AuditInput {
  action: string;
  entity?: string;
  entityId?: string;
  clinicId?: string | null;
  meta?: Record<string, unknown>;
}

/** HIPAA audit trail: who looked at / changed which record, and when. Never put PHI in meta. */
export async function audit(req: Request | null, input: AuditInput, actor?: string) {
  const user = req?.user;
  try {
    await db.insert(schema.auditLogs).values({
      userId: user?.id ?? null,
      clinicId: input.clinicId ?? user?.clinicId ?? null,
      actor: actor ?? user?.email ?? "system",
      action: input.action,
      entity: input.entity,
      entityId: input.entityId,
      ip: req?.ip ?? null,
      meta: input.meta ?? null,
    });
  } catch (e) {
    console.error("[audit] failed to write audit log", (e as Error).message);
  }
}
