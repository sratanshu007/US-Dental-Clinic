// Password rules (NIST 800-63B style): length over complexity, block common and context-based passwords.
import { z } from "zod";

const COMMON = new Set([
  "password", "password1", "password123", "123456789012", "qwertyuiop", "letmein", "welcome", "admin", "administrator",
  "iloveyou", "dentist", "dental", "receptionist", "changeme", "monkey", "dragon", "football", "baseball", "sunshine",
  "princess", "trustno1", "passw0rd", "abc123456789", "111111111111", "000000000000", "qwerty123456",
]);

export function passwordProblem(pw: string, ctx: { email?: string; name?: string } = {}): string | null {
  if (pw.length < 12) return "Use at least 12 characters";
  if (pw.length > 200) return "Password is too long";
  const low = pw.toLowerCase();
  const letters = low.replace(/[^a-z]/g, "");
  if (COMMON.has(low) || COMMON.has(low.replace(/[^a-z0-9]/g, "")) || COMMON.has(letters)) return "That password is too common";
  if (/^(.)\1+$/.test(pw)) return "Don't repeat one character";
  const local = ctx.email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && low.includes(local)) return "Don't use your email in the password";
  for (const part of (ctx.name ?? "").toLowerCase().split(/\s+/)) if (part.length >= 4 && low.includes(part)) return "Don't use your name in the password";
  if (new Set(pw).size < 6) return "Use more different characters";
  return null;
}

/** zod field for new passwords (context checks happen in the route, where email/name are known). */
export const newPassword = z.string().max(200).superRefine((p, ctx) => {
  const problem = passwordProblem(p);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});
