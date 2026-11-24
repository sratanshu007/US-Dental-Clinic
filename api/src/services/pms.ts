// PMS sync disabled — system uses built-in appointment scheduling

export class PmsError extends Error {}

export const patternFor = (minutes: number) => "X".repeat(Math.max(1, Math.round(minutes / 5)));
export const patternMinutes = (pattern: string) => Math.max(5, (pattern || "").length * 5);

export async function testConnection(_clinic: any) {
  return { providers: [], operatories: [] };
}

export async function pullBusy(_clinic: any): Promise<number> {
  return 0;
}

export async function pushAppointment(_clinicId: string, _appointmentId: string, _replacedId?: string) {
  return;
}

export async function syncAllPms(): Promise<void> {
  return;
}
