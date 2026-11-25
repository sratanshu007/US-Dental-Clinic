// Voice agent HTTP + WebSocket server (Node.js).
//
// Plivo setup (per clinic number): Plivo Application with
//   Answer URL = {PUBLIC_URL}/plivo/answer (POST), Hangup URL = {PUBLIC_URL}/plivo/hangup (POST)
// Calls are tracked in memory between the answer webhook and the media WebSocket, so run one
// instance per voice domain (or sticky routing by call).
import crypto from "node:crypto";
import http from "node:http";
import express, { type Request, type Response } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import * as api from "./apiClient";
import { CallSession, type CallInfo, TRANSFER_TARGETS } from "./call";
import { config } from "./config";
import { log } from "./log";
import { warmFillers } from "./tts";
import * as plivo from "./plivo";

interface Pending extends CallInfo { at: number; token: string }
const PENDING = new Map<string, Pending>(); // CallUUID -> info + one-time WS token
const CONNECTED_TASKS = new Set<string>();
const ACTIVE = new Set<CallSession>();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: false, limit: "64kb" }));
app.use(express.json({ limit: "64kb" }));
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  res.setHeader("Cache-Control", "no-store");
  next();
});

// Simple per-IP rate limit for the public webhook routes (Plivo sends a few requests per call)
const hits = new Map<string, { n: number; reset: number }>();
function rateLimit(max: number) {
  return (req: Request, res: Response, next: () => void) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, { n: 1, reset: now + 60_000 });
    else if (++h.n > max) return void res.status(429).send("Too many requests");
    next();
  };
}

function gc() {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, v] of PENDING) if (v.at < cutoff) PENDING.delete(k);
  for (const [k, v] of TRANSFER_TARGETS) if (v.at < cutoff) TRANSFER_TARGETS.delete(k);
  for (const [k, v] of hits) if (v.reset < Date.now()) hits.delete(k);
}
setInterval(gc, 60_000).unref();

const str = (v: unknown) => (typeof v === "string" ? v : Array.isArray(v) ? String(v[0] ?? "") : "");

/** Plivo signs every webhook; reject anything else. */
function verified(req: Request): boolean {
  const url = `${config.publicUrl}${req.originalUrl}`;
  const post = req.method === "POST" ? (req.body as Record<string, string | string[]>) ?? {} : {};
  return plivo.signatureOk(req.method, url, req.headers, post);
}

const params = (req: Request) => ({ ...(req.query as Record<string, unknown>), ...((req.body as Record<string, unknown>) ?? {}) });

function wsUrl(callUuid: string, token: string) {
  const base = config.publicUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  return `${base}/ws?call=${encodeURIComponent(callUuid)}&t=${token}`;
}

const xml = (res: Response, body: string) => res.type("application/xml").send(body);

// Patient calls the clinic number -> stream call audio to our WebSocket
app.all("/plivo/answer", rateLimit(120), (req, res) => {
  if (!verified(req)) return void res.status(401).send("Bad signature");
  const p = params(req);
  const callUuid = str(p.CallUUID);
  if (!callUuid) return void res.status(400).send("Missing CallUUID");
  const token = crypto.randomBytes(16).toString("hex");
  const info: Pending = { direction: "INBOUND", from: str(p.From), to: str(p.To), at: Date.now(), token };
  // Fetch the clinic + caller session now, while Plivo is still connecting the audio
  info.session = api.startCall("INBOUND", info.from, info.to, callUuid, null);
  info.session.catch(() => {});
  PENDING.set(callUuid, info);
  log.info("inbound call", { callUuid });
  xml(res, plivo.streamXml(wsUrl(callUuid, token)));
});

// Patient picked up our outbound call
app.all("/plivo/outbound-answer", rateLimit(120), (req, res) => {
  if (!verified(req)) return void res.status(401).send("Bad signature");
  const p = params(req);
  const callUuid = str(p.CallUUID);
  const taskId = str(p.task);
  if (!callUuid || !taskId) return void res.status(400).send("Missing CallUUID/task");
  const token = crypto.randomBytes(16).toString("hex");
  const info: Pending = { direction: "OUTBOUND", from: str(p.From), to: str(p.To), taskId, at: Date.now(), token };
  info.session = api.startCall("OUTBOUND", info.from, info.to, callUuid, taskId);
  info.session.catch(() => {});
  PENDING.set(callUuid, info);
  xml(res, plivo.streamXml(wsUrl(callUuid, token)));
});

// Call ended. For outbound calls nobody answered, tell the API so it can retry or give up.
app.post("/plivo/hangup", rateLimit(120), async (req, res) => {
  if (!verified(req)) return void res.status(401).send("Bad signature");
  const p = params(req);
  const taskId = str(p.task);
  if (taskId && !CONNECTED_TASKS.has(taskId)) {
    const status = str(p.CallStatus);
    const noAnswer = ["no-answer", "busy", "timeout", "cancel", "completed"].includes(status);
    await api.taskResult(taskId, noAnswer ? "NO_ANSWER" : "FAILED", status || null);
  }
  CONNECTED_TASKS.delete(taskId);
  res.send("ok");
});

app.get("/plivo/transfer-xml", rateLimit(60), (req, res) => {
  if (!verified(req)) return void res.status(401).send("Bad signature");
  const t = str(req.query.t);
  const target = TRANSFER_TARGETS.get(t);
  TRANSFER_TARGETS.delete(t);
  if (!target) return void xml(res, plivo.hangupXml("Sorry, we could not connect you. Please call back."));
  xml(res, plivo.dialXml(target.number, target.callerId));
});

function internalOk(req: Request): boolean {
  const got = Buffer.from(str(req.headers["x-internal-key"]));
  const exp = Buffer.from(config.internalApiKey);
  return got.length === exp.length && crypto.timingSafeEqual(got, exp);
}

// Called by the Node API job runner to place a no-show or feedback call
app.post("/outbound/start", async (req, res) => {
  if (!internalOk(req)) return void res.status(401).json({ error: "Invalid internal key" });
  const { taskId, to, from } = (req.body ?? {}) as Record<string, string>;
  if (!taskId || !to || !from || !/^\+1\d{10}$/.test(to) || !/^\+1\d{10}$/.test(from)) {
    return void res.status(400).json({ error: "taskId, to and from (E.164 US) are required" });
  }
  try {
    const r = await plivo.makeCall(
      to, from,
      `${config.publicUrl}/plivo/outbound-answer?task=${encodeURIComponent(taskId)}`,
      `${config.publicUrl}/plivo/hangup?task=${encodeURIComponent(taskId)}`,
    );
    res.json({ ok: true, requestUuid: r.request_uuid });
  } catch (e) {
    log.error("outbound call failed", { taskId, err: (e as Error).message });
    await api.taskResult(taskId, "FAILED", "plivo call failed");
    res.status(502).json({ error: "Plivo call failed" });
  }
});

app.get("/", (_req, res) => {
  res.json({
    service: "dental-ai-voice",
    status: "online",
    health: "/health",
    ready: "/ready",
  });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/ready", async (_req, res) => {
  const apiCheck = await api.apiReady();
  const checks = {
    deepgram_key: !!config.deepgram.apiKey,
    llm_key: !!config.llm.apiKey,
    plivo_keys: !!(config.plivo.authId && config.plivo.authToken),
    api: apiCheck.ok,
    api_url: config.apiUrl,
    ...(apiCheck.error ? { api_error: apiCheck.error } : {}),
  };
  const ok = checks.deepgram_key && checks.llm_key && checks.plivo_keys && checks.api;
  res.status(ok ? 200 : 503).json({ ok, activeCalls: ACTIVE.size, ...checks });
});

// Proxy non-voice routes (e.g. /webhooks/plivo/sms, /p/:token, /health) to the Node API
app.use(async (req, res) => {
  try {
    const targetUrl = new URL(req.originalUrl || req.url, config.apiUrl).toString();
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() === "host") continue;
      if (v) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    }
    const body = req.method !== "GET" && req.method !== "HEAD"
      ? (typeof req.body === "object" ? JSON.stringify(req.body) : req.body)
      : undefined;

    const apiRes = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
    });
    res.status(apiRes.status);
    apiRes.headers.forEach((v, k) => res.setHeader(k, v));
    const buf = Buffer.from(await apiRes.arrayBuffer());
    return res.send(buf);
  } catch (err: any) {
    return res.status(404).send("Not found");
  }
});

// ---------------- media WebSocket ----------------

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url ?? "/", "http://x");
  if (u.pathname !== "/ws") return socket.destroy();
  const callUuid = u.searchParams.get("call") ?? "";
  const token = u.searchParams.get("t") ?? "";
  const pending = PENDING.get(callUuid);
  // Only a stream for a call Plivo just announced, carrying that call's one-time token, may connect.
  const ok = !!pending && token.length === pending.token.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(pending.token));
  if (!ok) {
    log.warn("rejected media stream (unknown call or bad token)");
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return socket.destroy();
  }
  PENDING.delete(callUuid);
  wss.handleUpgrade(req, socket, head, (ws) => onMedia(ws, callUuid, pending!));
});

function onMedia(ws: WebSocket, callUuid: string, info: Pending) {
  // Plivo's first message is "start" with the stream ID
  const timer = setTimeout(() => ws.close(), 10_000);
  ws.once("message", (raw) => {
    clearTimeout(timer);
    let m: any;
    try { m = JSON.parse(raw.toString()); } catch { return ws.close(); }
    if (m.event !== "start" || !m.start?.streamId) return ws.close();
    if (info.taskId) CONNECTED_TASKS.add(info.taskId);
    const call = new CallSession(ws, m.start.streamId, callUuid, info);
    ACTIVE.add(call);
    ws.on("close", () => ACTIVE.delete(call));
    void call.start();
  });
}

if (require.main === module) {
  server.listen(config.port, () => {
    log.info(`voice agent listening on :${config.port}`, { env: config.env, llm: config.llm.provider, model: config.llm.model });
    warmFillers(); // "let me check…" phrases ready before the first call
  });
  const stop = () => {
    log.info("shutting down: finishing active calls");
    server.close();
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

export { app, server, PENDING };
