// Plivo: webhook signature (V3), XML responses, REST calls (outbound, transfer, hangup).
// Implemented without the Plivo SDK (its dependency tree has known critical vulnerabilities).
import crypto from "node:crypto";
import { config } from "./config";

type Params = Record<string, string | string[]>;

const asList = (v: string | string[]) => (Array.isArray(v) ? [...v] : [v]);

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

/** Plivo signature V3: HMAC-SHA256(authToken, baseUrl + "." + nonce), base64. */
export function v3Expected(method: string, uri: string, nonce: string, authToken: string, params: Params = {}): string {
  const base = method === "GET" ? getUrl(uri, params) : postUrl(uri, params);
  return crypto.createHmac("sha256", authToken).update(`${base}.${nonce}`).digest("base64");
}

/** The header may hold several signatures, comma-separated. Constant-time compare. */
export function validV3Signature(method: string, uri: string, nonce: string, authToken: string, signature: string, params: Params = {}): boolean {
  const exp = Buffer.from(v3Expected(method, uri, nonce, authToken, params));
  return signature.split(",").map((s) => s.trim()).some((s) => {
    const got = Buffer.from(s);
    return got.length === exp.length && crypto.timingSafeEqual(got, exp);
  });
}

export function signatureOk(method: string, url: string, headers: Record<string, string | string[] | undefined>, postParams: Params): boolean {
  if (!config.plivo.verifySignature) return true;
  const sig = headers["x-plivo-signature-v3"];
  const nonce = headers["x-plivo-signature-v3-nonce"];
  if (typeof sig !== "string" || typeof nonce !== "string" || !config.plivo.authToken) return false;
  try { return validV3Signature(method, url, nonce, config.plivo.authToken, sig, postParams); } catch { return false; }
}

const xmlEscape = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

export const streamXml = (wsUrl: string) => `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">${xmlEscape(wsUrl)}</Stream>
</Response>`;

export const dialXml = (number: string, callerId?: string) => `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial${callerId ? ` callerId="${xmlEscape(callerId)}"` : ""}><Number>${xmlEscape(number)}</Number></Dial>
</Response>`;

export const hangupXml = (message: string) => `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak voice="WOMAN" language="en-US">${xmlEscape(message)}</Speak>
  <Hangup/>
</Response>`;

async function rest(method: string, path: string, body?: unknown): Promise<any> {
  const auth = Buffer.from(`${config.plivo.authId}:${config.plivo.authToken}`).toString("base64");
  const r = await fetch(`${config.plivo.apiBase}/v1/Account/${config.plivo.authId}${path}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok && r.status !== 404) throw new Error(`Plivo ${method} ${path.split("/")[1]} failed (${r.status})`);
  const t = await r.text();
  return t ? JSON.parse(t) : {};
}

export const makeCall = (to: string, from: string, answerUrl: string, hangupUrl: string) =>
  rest("POST", "/Call/", {
    to, from, answer_url: answerUrl, answer_method: "GET", hangup_url: hangupUrl, hangup_method: "POST",
    ring_timeout: 30, machine_detection: "true",
  });

/** Point the live call (A leg) at new XML that dials the clinic staff line. */
export const transferCall = (callUuid: string, xmlUrl: string) =>
  rest("POST", `/Call/${encodeURIComponent(callUuid)}/`, { legs: "aleg", aleg_url: xmlUrl, aleg_method: "GET" });

export const hangupCall = (callUuid: string) => rest("DELETE", `/Call/${encodeURIComponent(callUuid)}/`);
