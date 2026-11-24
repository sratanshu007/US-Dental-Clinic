// Plivo without the Plivo SDK (its dependency tree carries known critical vulnerabilities):
// webhook signature V3 check and the one REST call the API needs (send SMS).
import crypto from "node:crypto";
import { config } from "../config";

type Params = Record<string, string | string[]>;
const asList = (v: string | string[]) => (Array.isArray(v) ? [...v] : [String(v)]);

function sortedQuery(params: Record<string, string[]>): string {
  const parts: string[] = [];
  for (const k of Object.keys(params).sort()) for (const v of [...params[k]].sort()) parts.push(`${k}=${v}`);
  return parts.join("&");
}

function getUrl(uri: string, params: Params, emptyPostParams = true): string {
  const u = new URL(uri);
  const merged: Record<string, string[]> = {};
  for (const [k, v] of u.searchParams) (merged[k] ??= []).push(v);
  for (const [k, v] of Object.entries(params)) merged[k] = [...(merged[k] ?? []), ...asList(v)];
  let base = `${u.protocol}//${u.host}${u.pathname}`;
  const q = sortedQuery(merged);
  if (q.length > 0 || !emptyPostParams) base += `?${q}`;
  if (q.length > 0 && !emptyPostParams) base += ".";
  return base;
}

function postUrl(uri: string, params: Params): string {
  const base = getUrl(uri, {}, Object.keys(params).length === 0);
  let s = "";
  for (const k of Object.keys(params).sort()) for (const v of asList(params[k]).sort()) s += `${k}${v}`;
  return base + s;
}

export function v3Expected(method: string, uri: string, nonce: string, authToken: string, params: Params = {}): string {
  const base = method === "GET" ? getUrl(uri, params) : postUrl(uri, params);
  return crypto.createHmac("sha256", authToken).update(`${base}.${nonce}`).digest("base64");
}

/** Matches plivo.validateV3Signature (verified against the SDK with test vectors), constant-time. */
export function validateV3Signature(method: string, uri: string, nonce: string, authToken: string, signature: string, params: Params = {}): boolean {
  const exp = Buffer.from(v3Expected(method, uri, nonce, authToken, params));
  return signature.split(",").map((s) => s.trim()).some((s) => {
    const got = Buffer.from(s);
    return got.length === exp.length && crypto.timingSafeEqual(got, exp);
  });
}

export async function sendMessage(src: string, dst: string, text: string, opts: { url?: string; log?: boolean } = {}): Promise<string | null> {
  const auth = Buffer.from(`${config.plivo.authId}:${config.plivo.authToken}`).toString("base64");
  const base = (process.env.PLIVO_API_BASE ?? "https://api.plivo.com").replace(/\/$/, "");
  const r = await fetch(`${base}/v1/Account/${config.plivo.authId}/Message/`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({ src, dst, text, ...(opts.url ? { url: opts.url, method: "POST" } : {}), ...(opts.log === false ? { log: false } : {}) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Plivo message failed (${r.status})`);
  const j = (await r.json()) as { message_uuid?: string[] };
  return j.message_uuid?.[0] ?? null;
}
