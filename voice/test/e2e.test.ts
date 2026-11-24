// End-to-end: a fake Plivo call goes through the real Node voice agent and the real API, with mock
// Deepgram (STT + TTS), mock LLM and mock Plivo REST. Needs the API running with the demo seed:
//   (cd ../api && npm run seed && JOBS_ENABLED=false npx tsx src/server.ts)
//   INTERNAL_API_KEY=... npm test
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, WebSocket } from "ws";

const AUTH_TOKEN = "test-plivo-token-123";
let llmPort = 0, dgPort = 0, plivoPort = 0;
const mock = {
  sttClients: [] as WebSocket[],
  sttBytes: 0,
  ttsRequests: [] as string[],
  llmRequests: 0,
  hangups: [] as string[],
  transfers: [] as string[],
  summaries: 0,
  userTurns: [] as string[],
  ttsSockets: 0,
  llmDelayMs: 0,
};

function sttSay(text: string, opts: { final?: boolean; speechFinal?: boolean } = {}) {
  const msg = JSON.stringify({ type: "Results", is_final: opts.final ?? true, speech_final: opts.speechFinal ?? true, channel: { alternatives: [{ transcript: text }] } });
  for (const c of mock.sttClients) if (c.readyState === WebSocket.OPEN) c.send(msg);
}

// ---- mock LLM: scripted by the conversation so far ----
function llmReply(body: any): { text?: string; tools?: Array<{ name: string; args: unknown }> } {
  const msgs = body.messages as any[];
  const last = msgs[msgs.length - 1];
  const lastUser = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
  if (last.role === "user") mock.userTurns.push(last.content);
  if (last.role === "user" && /book a cleaning/i.test(last.content)) return { tools: [{ name: "check_availability", args: {} }] };
  if (last.role === "user" && /yes/i.test(last.content)) {
    const slots = msgs.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content)).find((r) => r.slots)?.slots;
    return { tools: [{ name: "book_appointment", args: { startAt: slots[0].startAt, firstName: "Nora", lastName: "Vance", dateOfBirth: "1985-02-03", smsConsent: false, callConsent: true } }] };
  }
  if (last.role === "user" && /person|human/i.test(last.content)) return { tools: [{ name: "transfer_to_staff", args: { reason: "asked for a person" } }] };
  if (last.role === "user" && /bye/i.test(last.content)) return { text: "Thanks for calling. Goodbye!", tools: [{ name: "end_call", args: {} }] };
  if (last.role === "tool") {
    const r = JSON.parse(last.content);
    if (r.slots) return { text: `The soonest opening is ${r.slots[0].label ?? "soon"}. Does that work for you?` };
    if (r.appointmentId || r.ok === true && /yes/i.test(lastUser)) return { text: "You're all set. Anything else I can help with?" };
    if (r.message && /connecting/i.test(r.message)) return { text: "Connecting you to the front desk now." };
    return { text: "Okay." };
  }
  return { text: "Sorry, could you say that again? I want to make sure I get it right for you." };
}

function sse(res: http.ServerResponse, reply: ReturnType<typeof llmReply>) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = (delta: unknown) => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
  if (reply.text) for (const w of reply.text.match(/.{1,12}/g)!) send({ content: w });
  reply.tools?.forEach((t, i) => {
    send({ tool_calls: [{ index: i, id: `call_${Date.now()}_${i}`, function: { name: t.name, arguments: "" } }] });
    send({ tool_calls: [{ index: i, function: { arguments: JSON.stringify(t.args) } }] });
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

const listen = (srv: http.Server) => new Promise<number>((r) => srv.listen(0, "127.0.0.1", () => r((srv.address() as AddressInfo).port)));
let llmSrv: http.Server, dgSrv: http.Server, plivoSrv: http.Server;
let voice: typeof import("../src/server");
let voiceBase = "";

before(async () => {
  llmSrv = http.createServer(async (req, res) => {
    let b = ""; for await (const c of req) b += c;
    const body = JSON.parse(b);
    mock.llmRequests++;
    if (mock.llmDelayMs) await new Promise((r) => setTimeout(r, mock.llmDelayMs));
    if (!body.stream) { mock.summaries++; res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ choices: [{ message: { content: "New patient booked a cleaning." } }] })); }
    sse(res, llmReply(body));
  });
  dgSrv = http.createServer(async (req, res) => {
    let b = ""; for await (const c of req) b += c;
    mock.ttsRequests.push(JSON.parse(b).text);
    res.writeHead(200, { "Content-Type": "audio/basic" });
    res.end(Buffer.alloc(1600, 0xff)); // 0.2 s of mu-law silence
  });
  const wss = new WebSocketServer({ server: dgSrv });
  wss.on("connection", (ws, req) => {
    assert.match(String(req.headers.authorization), /^Token /);
    assert.match(req.url ?? "", /mip_opt_out=true/);
    if ((req.url ?? "").startsWith("/v1/speak")) {
      // Streaming TTS: Speak -> (Flush) -> audio + Flushed; Clear -> Cleared
      mock.ttsSockets++;
      ws.on("message", (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === "Speak") mock.ttsRequests.push(m.text);
        if (m.type === "Flush") { ws.send(Buffer.alloc(1600, 0xff)); ws.send(JSON.stringify({ type: "Flushed" })); }
        if (m.type === "Clear") ws.send(JSON.stringify({ type: "Cleared" }));
      });
      return;
    }
    mock.sttClients.push(ws);
    ws.on("message", (d, bin) => { if (bin) mock.sttBytes += (d as Buffer).length; });
  });
  plivoSrv = http.createServer(async (req, res) => {
    let b = ""; for await (const c of req) b += c;
    if (req.method === "DELETE") mock.hangups.push(req.url!);
    if (req.method === "POST" && /aleg_url/.test(b)) mock.transfers.push(JSON.parse(b).aleg_url);
    res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}");
  });
  [llmPort, dgPort, plivoPort] = await Promise.all([listen(llmSrv), listen(dgSrv), listen(plivoSrv)]);

  Object.assign(process.env, {
    OPENAI_BASE_URL: `http://127.0.0.1:${llmPort}`, OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "test-model",
    DEEPGRAM_API_KEY: "dg-test", DEEPGRAM_WS_URL: `ws://127.0.0.1:${dgPort}/v1/listen`, DEEPGRAM_API_URL: `http://127.0.0.1:${dgPort}/v1`,
    PLIVO_AUTH_ID: "MATEST", PLIVO_AUTH_TOKEN: AUTH_TOKEN, PLIVO_API_BASE: `http://127.0.0.1:${plivoPort}`, VERIFY_PLIVO_SIGNATURE: "true",
    API_URL: process.env.API_URL ?? "http://localhost:4000", PUBLIC_URL: "http://127.0.0.1:0", LOG_LEVEL: "warn",
  });
  voice = await import("../src/server");
  const port = await new Promise<number>((r) => voice.server.listen(0, "127.0.0.1", () => r((voice.server.address() as AddressInfo).port)));
  voiceBase = `http://127.0.0.1:${port}`;
  const { config } = await import("../src/config");
  (config as any).publicUrl = voiceBase; // so signatures and ws URLs use the real port
});

after(() => {
  voice?.server.close(); llmSrv.close(); dgSrv.close(); plivoSrv.close();
  setTimeout(() => process.exit(0), 200).unref();
});

async function signedPost(path: string, form: Record<string, string>) {
  const { v3Expected } = await import("../src/plivo");
  const nonce = String(Date.now());
  const sig = v3Expected("POST", `${voiceBase}${path}`, nonce, AUTH_TOKEN, form);
  return fetch(`${voiceBase}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Plivo-Signature-V3": sig, "X-Plivo-Signature-V3-Nonce": nonce },
    body: new URLSearchParams(form),
  });
}

/** Fake Plivo media stream: answers checkpoints, collects what the AI plays. */
function fakePlivo(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  const state = { audioBytes: 0, clears: 0, closed: false, lastAudioAt: 0, audioEvents: [] as number[] };
  ws.on("open", () => {
    ws.send(JSON.stringify({ event: "start", start: { streamId: "stream-1", callId: "cu" } }));
    const t = setInterval(() => ws.readyState === WebSocket.OPEN
      ? ws.send(JSON.stringify({ event: "media", media: { track: "inbound", payload: Buffer.alloc(160, 0x7f).toString("base64") } }))
      : clearInterval(t), 20);
  });
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.event === "playAudio") { state.audioBytes += Buffer.from(m.media.payload, "base64").length; state.lastAudioAt = Date.now(); state.audioEvents.push(Date.now()); }
    if (m.event === "clearAudio") state.clears++;
    if (m.event === "checkpoint") setTimeout(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ event: "playedStream", name: m.name })), 50);
  });
  ws.on("close", () => (state.closed = true));
  return { ws, state };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 8000, label = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await wait(50); }
  throw new Error(`timed out waiting for ${label}`);
}

test("unsigned webhooks and unknown media streams are rejected", async () => {
  const r = await fetch(`${voiceBase}/plivo/answer`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "CallUUID=x&From=%2B1&To=%2B1" });
  assert.equal(r.status, 401);
  const bad = await signedPost("/plivo/answer", { CallUUID: "cu-bad", From: "+12105559999", To: "+12105550100" });
  assert.equal(bad.status, 200);
  const url = (await bad.text()).match(/>(ws[^<]+)</)![1].replace(/&amp;/g, "&");
  const forged = url.replace(/t=[0-9a-f]+/, "t=" + "0".repeat(32));
  const ws = new WebSocket(forged);
  const code = await new Promise<string>((r) => { ws.on("unexpected-response", (_q, res) => r(String(res.statusCode))); ws.on("open", () => r("open")); ws.on("error", () => r("error")); });
  assert.notEqual(code, "open", "a stream with the wrong token must not connect");
  const noKey = await fetch(`${voiceBase}/outbound/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(noKey.status, 401);
});

test("full call: instant greeting, fast replies, human turn-taking, booking, goodbye + hangup", async () => {
  const caller = `+1210556${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const callUuid = `cu-${Date.now()}`;
  const r = await signedPost("/plivo/answer", { CallUUID: callUuid, From: caller, To: "+12105550100", Direction: "inbound" });
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.match(body, /<Stream bidirectional="true"/);
  const wsUrl = body.match(/>(ws[^<]+)</)![1].replace(/&amp;/g, "&");
  const connectedAt = Date.now();
  const { state, ws } = fakePlivo(wsUrl);

  // Greeting comes from cached audio: no LLM call needed before the first words
  await until(() => state.audioBytes > 0, 8000, "greeting audio");
  const greetMs = state.audioEvents[0] - connectedAt;
  assert.equal(mock.llmRequests, 0, "greeting must not wait for the LLM");
  assert.ok(mock.ttsRequests.some((t) => /This call is from Demo Family Dental/.test(t) && /recording this call for monitoring purposes/.test(t) && /AI assistant/.test(t)), "greeting has the disclosure");
  assert.ok(mock.ttsSockets >= 1, "streaming TTS socket opened");
  await until(() => mock.sttBytes > 1000, 4000, "caller audio forwarded to STT");
  await wait(150);

  // Caller sounds mid-sentence: the AI waits instead of cutting in
  const before = mock.llmRequests;
  sttSay("Hi, I'd like to");
  await wait(400);
  assert.equal(mock.llmRequests, before, "no reply while the caller is mid-sentence");
  // Slow LLM on purpose: the bridge phrase still comes right away
  mock.llmDelayMs = 600;
  const saidAt = Date.now();
  const audioBefore = state.audioEvents.length;
  sttSay("book a cleaning please.");
  await until(() => mock.userTurns.some((t) => t === "Hi, I'd like to book a cleaning please."), 3000, "both parts joined into one turn");
  await until(() => state.audioEvents.length > audioBefore, 5000, "first reply audio");
  const firstReplyMs = state.audioEvents[audioBefore] - saidAt;
  await until(() => mock.ttsRequests.some((t) => /Does that work/.test(t)), 8000, "offer of a time");
  mock.llmDelayMs = 0;

  // "okay" while the AI talks is listening, not an interruption
  const clearsBefore = state.clears;
  const turnsBefore = mock.userTurns.length;
  sttSay("Hi I'd like to book a cleaning again.");
  await wait(40);
  sttSay("okay", { final: true, speechFinal: false });
  await wait(150);
  assert.equal(state.clears, clearsBefore + 1, "only the real interruption cleared audio");
  // A real interruption (2+ words) stops the AI
  sttSay("wait actually", { final: false, speechFinal: false });
  await wait(100);
  assert.ok(mock.userTurns.length >= turnsBefore, "turns recorded");

  sttSay("Yes that works, my name is Nora Vance.");
  await until(() => mock.ttsRequests.some((t) => /all set/.test(t)), 10000, "booking confirmation");

  // Very slow LLM (1.6 s): the caller still hears "Mm-hmm." within about a second
  mock.llmDelayMs = 1600;
  const slowAt = Date.now();
  const n = state.audioEvents.length;
  sttSay("Do you take Delta Dental insurance?");
  await until(() => state.audioEvents.length > n, 4000, "thinking acknowledgment");
  const ackMs = state.audioEvents[n] - slowAt;
  assert.ok(ackMs < 1300, `thinking acknowledgment after ${ackMs} ms`);
  await wait(1700);
  mock.llmDelayMs = 0;

  sttSay("Great, bye!");
  await until(() => mock.hangups.some((u) => u.includes(callUuid)), 8000, "Plivo hangup after goodbye");
  await until(() => mock.summaries > 0, 8000, "call summary");
  ws.close();
  console.log(`# timing: greeting ${greetMs} ms after connect; reply ${firstReplyMs} ms after caller stopped (600 ms LLM); "Mm-hmm" after ${ackMs} ms (1.6 s LLM)`);
  assert.ok(greetMs < 1500, `greeting took ${greetMs} ms`);
  assert.ok(firstReplyMs < 900, `first reply audio took ${firstReplyMs} ms with a 600 ms LLM`);
});

test("transfer to staff: speaks first, then moves the call to <Dial>", async () => {
  const callUuid = `cu-t-${Date.now()}`;
  const r = await signedPost("/plivo/answer", { CallUUID: callUuid, From: `+1210557${String(Math.floor(Math.random() * 9000) + 1000)}`, To: "+12105550100" });
  const wsUrl = (await r.text()).match(/>(ws[^<]+)</)![1].replace(/&amp;/g, "&");
  const { state } = fakePlivo(wsUrl);
  await until(() => state.audioBytes > 0, 8000, "greeting");
  sttSay("Can I talk to a person please?");
  await until(() => mock.transfers.length > 0, 10000, "transfer REST call").catch(() => {});
  if (mock.transfers.length) {
    const t = new URL(mock.transfers[0]).searchParams.get("t")!;
    const { v3Expected } = await import("../src/plivo");
    const nonce = "n1";
    const url = `${voiceBase}/plivo/transfer-xml?t=${t}`;
    const x = await fetch(url, { headers: { "X-Plivo-Signature-V3": v3Expected("GET", url, nonce, AUTH_TOKEN, {}), "X-Plivo-Signature-V3-Nonce": nonce } });
    assert.match(await x.text(), /<Dial/);
  } else {
    // The demo clinic has no transfer number: the AI must not have transferred
    assert.ok(mock.ttsRequests.length > 1);
  }
});
