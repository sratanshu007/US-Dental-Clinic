/** Normalize a US phone number to E.164 (+1XXXXXXXXXX). Returns null if it can't. */
export function normalizeUsPhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+") && digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** "+12105550142" -> "(210) 555-0142" */
export function formatUsPhone(e164: string): string {
  const d = e164.replace(/\D/g, "").slice(-10);
  if (d.length !== 10) return e164;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/** Last 4 digits only — safe to show in logs and notifications. */
export const maskPhone = (e164: string) => `***-***-${e164.slice(-4)}`;
