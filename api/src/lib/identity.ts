// Caller identity check helpers. Caller ID can be spoofed, so before the AI reads out or changes an
// existing appointment the caller must give the name on file AND date of birth (or last name, for
// patients without a DOB on file yet).
import crypto from "node:crypto";
import { DateTime } from "luxon";
import { config } from "../config";

// Separate key derived from the master key, so a DOB hash can't be reversed with the encryption key alone
const HMAC_KEY = crypto.createHmac("sha256", Buffer.from(config.encryptionKey, "hex")).update("dob-hmac-v1").digest();

/** Normalize a date of birth to YYYY-MM-DD, or null if it isn't a plausible DOB. */
export function normalizeDob(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim();
  const formats = ["yyyy-MM-dd", "M/d/yyyy", "MM/dd/yyyy", "M-d-yyyy", "LLLL d yyyy", "LLLL d, yyyy", "LLL d yyyy", "LLL d, yyyy"];
  for (const f of formats) {
    const d = DateTime.fromFormat(s, f, { zone: "utc" });
    if (d.isValid) {
      const age = DateTime.utc().diff(d, "years").years;
      if (age < 0 || age > 120) return null;
      return d.toISODate();
    }
  }
  return null;
}

export function dobHash(dob: string): string {
  return crypto.createHmac("sha256", HMAC_KEY).update(dob).digest("hex");
}

const norm = (s: string | null | undefined) =>
  (s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");

/** Loose first-name match: "Jon" vs "John" is not a match; case, accents and spaces are ignored. */
export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = norm(a), y = norm(b);
  return !!x && x === y;
}

export const MAX_VERIFY_ATTEMPTS = 3;
