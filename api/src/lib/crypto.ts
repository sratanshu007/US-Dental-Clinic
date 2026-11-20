import crypto from "node:crypto";
import { config } from "../config";

let rawKeyBuf = Buffer.from(config.encryptionKey, "hex");
if (rawKeyBuf.length !== 32 || !/^[0-9a-fA-F]{64}$/.test(config.encryptionKey)) {
  rawKeyBuf = crypto.createHash("sha256").update(config.encryptionKey).digest();
}
const KEY = rawKeyBuf;

/** AES-256-GCM. Output: "v1:<iv b64>:<tag b64>:<ciphertext b64>" */
export function encrypt(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === "") return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decrypt(payload: string | null | undefined): string | null {
  if (!payload) return null;
  const [v, ivB64, tagB64, dataB64] = payload.split(":");
  if (v !== "v1") throw new Error("Unknown ciphertext version");
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

export function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function randomToken(bytes = 48): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// ---------------- TOTP (RFC 6238) for 2-factor login ----------------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error("Invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function totpCode(secret: string, timeMs = Date.now(), step = 30): string {
  const counter = Math.floor(timeMs / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString();
  return code.padStart(6, "0");
}

/** Accepts the current code and one step either side (clock drift). */
export function verifyTotp(secret: string, code: string): boolean {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return false;
  const now = Date.now();
  return [-1, 0, 1].some((w) => safeEqual(totpCode(secret, now + w * 30_000), c));
}

export function totpUri(secret: string, account: string, issuer = "Deific Dental AI"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
