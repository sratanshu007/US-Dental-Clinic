// One phone call: Plivo audio -> Deepgram STT -> LLM (+tools) -> Deepgram TTS -> Plivo.
//
// Built to feel like talking to a person:
//  * Greeting plays instantly from cached audio (the session is fetched while the phone is still ringing).
//  * The caller's turn ends ~300 ms after they stop talking — but if they sound mid-sentence
//    ("my name is…", "um", "and") we wait a little longer instead of cutting in.
//  * The reply starts speaking as soon as its first sentence (or first clause) is written, over a
//    streaming TTS socket, while the rest is still being generated.
//  * Before a lookup the AI says a short bridge ("Let me check what's open.") so there's no dead air.
//  * "Okay", "uh-huh", "yeah" while the AI talks are treated as listening, not interruptions.
//    Real interruptions (2+ words) stop the AI immediately (barge-in).
//  * Plivo checkpoints tell us when audio has actually played, so hang-up/transfer never cut a sentence.
import crypto from "node:crypto";
import WebSocket from "ws";
import * as api from "./apiClient";
import type { Session } from "./apiClient";
import { config } from "./config";
import { chatStream, type Message, SentenceSplitter, summarize, type ToolCall } from "./llm";
import { log } from "./log";
import * as plivo from "./plivo";
import { buildPrompt, openingLine } from "./prompts";
import { DeepgramStt } from "./stt";
import { API_TOOLS, toolsFor, type ToolName } from "./tools";
import { cachedAudio, FILLERS, speak, THINKING, TtsStream } from "./tts";

export interface CallInfo {
  direction: "INBOUND" | "OUTBOUND";
  from: string;
  to: string;
  taskId?: string;
  /** Started by the answer webhook so it's ready when audio connects */
  session?: Promise<Session>;
}

/** token -> staff number, read by /plivo/transfer-xml (short-lived) */
export const TRANSFER_TARGETS = new Map<string, { number: string; callerId?: string; at: number }>();

const MAX_TOOL_ROUNDS = 6;
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

// "Listening noises" — not a real interruption while the AI is talking
const BACKCHANNEL = /^(ok(ay)?|k|yeah|yep|yes|uh[- ]?huh|mm[- ]?hmm|mhm|hmm|right|sure|alright|all right|got it|cool|great|i see|oh|ah|aha)[.!,]?$/i;
// Sounds like they're not done yet
const INCOMPLETE = /(\b(and|but|so|or|because|um+|uh+|er+|like|my name is|it's|it is|i'm|i am|i want|i'd like|i need|the|a|to|for|at|on|with|is)|,)\s*$/i;

export class CallSession {
  private session!: Session;
  private messages: Message[] = [];
  private stt = new DeepgramStt();
  private tts = new TtsStream();
  private started = Date.now();
  private userBuf = "";
  private commitTimer: NodeJS.Timeout | null = null;
  private abort: AbortController | null = null;
  private responding: Promise<void> | null = null;
  private speaking = false; // audio queued at Plivo and not yet played
  private pendingCheckpoint: { name: string; resolve: () => void; timer: NodeJS.Timeout } | null = null;
  private ttsChain: Promise<void> = Promise.resolve();
  private bytesQueued = 0;
  private endRequested = false;
  private transferring = false;
  private finished = false;
  private maxTimer: NodeJS.Timeout | null = null;
  private seq = 0;
  private fillerTurn = 0;
  private turnEndedAt = 0; // for latency metrics
  private firstAudioLogged = true;
  private latencies: number[] = [];
  private thinkTimer: NodeJS.Timeout | null = null;
  private thinkTurn = 0;

  constructor(private ws: WebSocket, private streamId: string, private callUuid: string, private info: CallInfo) {}

  async start(): Promise<void> {
    // Open speech sockets right away, in parallel with fetching the session
    this.stt.connect();
    this.tts.connect();
    this.tts.on("audio", (chunk) => this.playAudio(chunk));
    this.tts.on("error", (e) => log.warn("tts stream unavailable, using HTTPS", { err: e.message }));
    this.ws.on("message", (raw) => this.onPlivoMessage(raw.toString()));
    this.ws.on("close", () => void this.finish("caller hung up"));

    try {
      this.session = await (this.info.session ?? api.startCall(this.info.direction, this.info.from, this.info.to, this.callUuid, this.info.taskId));
    } catch (e) {
      log.error("could not start call session", { err: (e as Error).message });
      this.stt.close();
      this.tts.close();
      this.ws.close();
      return;
    }
    log.info("call started", { callId: this.session.callId, purpose: this.session.purpose, direction: this.info.direction });
    this.messages.push({ role: "system", content: buildPrompt(this.session) });

    this.stt.on("interim", (text) => {
      this.cancelPendingCommit(); // still talking
      if (this.isAiTalking() && words(text) >= 2 && !BACKCHANNEL.test(text.trim())) this.interrupt();
    });
    this.stt.on("final", (text, speechFinal) => {
      if (text) {
        this.cancelPendingCommit();
        const t = text.trim();
        if (this.isAiTalking() && !this.userBuf && BACKCHANNEL.test(t)) return; // "okay" while AI talks: just listening
        if (this.isAiTalking()) this.interrupt();
        this.userBuf = `${this.userBuf} ${t}`.trim();
      }
      if (speechFinal) this.scheduleCommit();
    });
    this.stt.on("utteranceEnd", () => this.commitUserTurn());
    this.stt.on("error", (e) => {
      if (!this.finished) log.warn("stt error", { err: e.message, callId: this.session.callId });
    });

    this.maxTimer = setTimeout(() => {
      log.warn("call hit max duration", { callId: this.session.callId });
      void this.hangup();
    }, config.maxCallSeconds * 1000);

    // Greet immediately from cached audio — no LLM round trip for the first words
    const opening = openingLine(this.session);
    this.messages.push({ role: "assistant", content: opening });
    try {
      this.playAudio(await cachedAudio(opening));
      void this.waitPlayed();
    } catch (e) {
      log.warn("greeting audio failed", { err: (e as Error).message });
    }
  }

  // ---------------- Plivo media stream ----------------

  private onPlivoMessage(raw: string) {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.event === "media" && m.media?.payload) {
      if (m.media.track && m.media.track !== "inbound") return;
      this.stt.send(Buffer.from(m.media.payload, "base64"));
    } else if (m.event === "playedStream") {
      const cp = this.pendingCheckpoint;
      if (cp && m.name === cp.name) cp.resolve();
    } else if (m.event === "stop") {
      void this.finish("stream stopped");
    }
  }

  private sendPlivo(obj: unknown) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private playAudio(chunk: Buffer) {
    if (!chunk.length) return;
    if (!this.firstAudioLogged && this.turnEndedAt) {
      this.firstAudioLogged = true;
      const ms = Date.now() - this.turnEndedAt;
      this.latencies.push(ms);
      log.info("reply latency", { ms, callId: this.session?.callId });
    }
    this.bytesQueued += chunk.length;
    this.speaking = true;
    this.sendPlivo({ event: "playAudio", media: { contentType: "audio/x-mulaw", sampleRate: 8000, payload: chunk.toString("base64") } });
  }

  private clearAudio() {
    this.sendPlivo({ event: "clearAudio", streamId: this.streamId });
    this.speaking = false;
    this.bytesQueued = 0;
    if (this.pendingCheckpoint) { clearTimeout(this.pendingCheckpoint.timer); this.pendingCheckpoint.resolve(); }
  }

  /** Resolves when everything queued so far has been played (or a safe estimate passes). */
  private waitPlayed(): Promise<void> {
    if (!this.speaking) return Promise.resolve();
    const name = `cp${++this.seq}`;
    const estimateMs = Math.ceil((this.bytesQueued / 8000) * 1000) + 1500; // 8 kHz mu-law = 8000 bytes/s
    return new Promise<void>((resolve) => {
      const done = () => {
        if (this.pendingCheckpoint?.name === name) this.pendingCheckpoint = null;
        clearTimeout(timer);
        this.speaking = false;
        this.bytesQueued = 0;
        resolve();
      };
      const timer = setTimeout(done, estimateMs);
      this.pendingCheckpoint = { name, resolve: done, timer };
      this.sendPlivo({ event: "checkpoint", streamId: this.streamId, name });
    });
  }

  private isAiTalking() {
    return this.speaking || this.responding !== null;
  }

  // ---------------- turns ----------------

  private cancelPendingCommit() {
    if (this.commitTimer) { clearTimeout(this.commitTimer); this.commitTimer = null; }
  }

  /** End of speech: answer now, unless they sound mid-sentence — then give them a moment. */
  private scheduleCommit() {
    this.cancelPendingCommit();
    if (!this.userBuf) return;
    if (INCOMPLETE.test(this.userBuf)) {
      this.commitTimer = setTimeout(() => this.commitUserTurn(), config.deepgram.incompleteWaitMs);
    } else {
      this.commitUserTurn();
    }
  }

  private commitUserTurn() {
    this.cancelPendingCommit();
    const text = this.userBuf.trim();
    if (!text || this.finished || this.transferring || this.endRequested) return;
    this.userBuf = "";
    if (this.responding) this.interrupt();
    this.messages.push({ role: "user", content: text });
    this.turnEndedAt = Date.now();
    this.firstAudioLogged = false;
    this.respond();
  }

  /** Barge-in: stop generating and clear what Plivo hasn't played yet. */
  private interrupt() {
    if (this.endRequested || this.transferring) return; // let the goodbye / transfer line finish
    if (!this.abort && !this.speaking) return;
    this.abort?.abort();
    this.abort = null;
    this.tts.clear();
    this.clearAudio();
    this.ttsChain = Promise.resolve();
  }

  private respond() {
    const ctrl = new AbortController();
    this.abort = ctrl;
    // A slow LLM shouldn't mean silence: after a beat, a short "Mm-hmm." like a person thinking
    if (this.thinkTimer) clearTimeout(this.thinkTimer);
    if (config.deepgram.thinkingAckMs > 0 && this.turnEndedAt) {
      this.thinkTimer = setTimeout(() => {
        if (this.firstAudioLogged || ctrl.signal.aborted || this.finished) return;
        const text = THINKING[this.thinkTurn++ % THINKING.length];
        cachedAudio(text).then((a) => { if (!this.firstAudioLogged && !ctrl.signal.aborted) this.playAudio(a); }).catch(() => {});
      }, config.deepgram.thinkingAckMs);
    }
    const run = this.generate(ctrl.signal)
      .catch((e) => {
        if (!ctrl.signal.aborted) log.error("response failed", { err: (e as Error).message, callId: this.session.callId });
      })
      .finally(() => {
        if (this.responding === run) this.responding = null;
        if (this.abort === ctrl) this.abort = null;
      });
    this.responding = run;
  }

  /** Speak one sentence: streaming socket when available, HTTPS otherwise. Sentences play in order. */
  private queueSpeech(sentence: string, signal: AbortSignal, spoken: string[]) {
    spoken.push(sentence);
    if (!this.tts.unavailable) {
      // The socket keeps order itself; send right away so synthesis overlaps generation
      const p = this.tts.say(sentence);
      this.ttsChain = this.ttsChain.then(() => p);
      return;
    }
    this.ttsChain = this.ttsChain.then(async () => {
      if (signal.aborted) return;
      try {
        for await (const chunk of speak(sentence, signal)) {
          if (signal.aborted) return;
          this.playAudio(chunk);
        }
      } catch (e) {
        if (!signal.aborted) log.warn("tts failed", { err: (e as Error).message });
      }
    });
  }

  /** A short bridge phrase before a lookup, from cached audio (instant). */
  private async filler(tool: string, signal: AbortSignal) {
    const list = FILLERS[tool] ?? FILLERS.default;
    const text = list[this.fillerTurn++ % list.length];
    try {
      const audio = await cachedAudio(text);
      await this.ttsChain; // after anything already queued
      if (signal.aborted) return;
      this.playAudio(audio);
      this.messages.push({ role: "assistant", content: text });
    } catch { /* not worth failing the turn */ }
  }

  private async generate(signal: AbortSignal): Promise<void> {
    const tools = toolsFor(this.session.purpose, !!this.session.clinic.transferNumber);
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const splitter = new SentenceSplitter();
      const spoken: string[] = [];
      let calls: ToolCall[] = [];
      let fullText = "";
      try {
        for await (const ev of chatStream(this.messages, tools, signal)) {
          if (ev.type === "text") for (const s of splitter.push(ev.delta)) this.queueSpeech(s, signal, spoken);
          else { calls = ev.toolCalls; fullText = ev.text; }
        }
      } catch (e) {
        if (signal.aborted) {
          // Keep roughly what the caller heard so the AI knows it was cut off
          if (spoken.length) this.messages.push({ role: "assistant", content: `${spoken.join(" ")} …` });
          return;
        }
        throw e;
      }
      const tail = splitter.flush();
      if (tail) this.queueSpeech(tail, signal, spoken);
      if (signal.aborted) return;

      this.messages.push({ role: "assistant", content: fullText || null, ...(calls.length ? { tool_calls: calls } : {}) });
      if (!calls.length) break;

      // Dead air while we look something up feels robotic: say a quick bridge if the AI didn't already.
      const lookup = calls.find((c) => API_TOOLS.has(c.function.name as ToolName) && c.function.name !== "opt_out_calls");
      const fillerDone = lookup && !spoken.length ? this.filler(lookup.function.name, signal) : Promise.resolve();

      let runAgain = false;
      const results = await Promise.all(calls.map(async (c) => {
        const name = c.function.name as ToolName;
        let args: Record<string, unknown> = {};
        try { args = c.function.arguments ? JSON.parse(c.function.arguments) : {}; } catch { /* bad JSON from model */ }
        let result: Record<string, unknown>;
        if (API_TOOLS.has(name)) {
          result = await api.tool(name, this.session.callId, args);
          log.info("tool", { name, ok: result.ok !== false, callId: this.session.callId });
          runAgain = true;
        } else if (name === "end_call") {
          this.endRequested = true;
          result = { ok: true };
        } else if (name === "transfer_to_staff") {
          const r = await api.tool("transfer_requested", this.session.callId, args);
          if (r.transferNumber) {
            this.transferring = true;
            result = { ok: true, message: "Tell the caller you're connecting them now, in one short sentence. Say nothing else." };
            void this.transferAfterSpeech(String(r.transferNumber));
          } else {
            result = { ok: false, error: "Transfer not available. Use save_inquiry for a callback." };
          }
          runAgain = true;
        } else {
          result = { ok: false, error: `Unknown tool ${name}` };
          runAgain = true;
        }
        return { role: "tool" as const, tool_call_id: c.id, content: JSON.stringify(result) };
      }));
      await fillerDone;
      if (signal.aborted) return;
      this.messages.push(...results);
      if (this.endRequested) break;
      if (!runAgain) break;
    }
    await this.ttsChain;
    if (this.endRequested && !signal.aborted) {
      await this.waitPlayed();
      await this.hangup();
    } else if (!signal.aborted) {
      void this.waitPlayed();
    }
  }

  private async transferAfterSpeech(number: string) {
    // Let the "connecting you now" line be generated and played
    await new Promise((r) => setTimeout(r, 300));
    if (this.responding) await this.responding.catch(() => {});
    await this.waitPlayed();
    const token = crypto.randomBytes(16).toString("hex");
    TRANSFER_TARGETS.set(token, {
      number, callerId: this.info.direction === "INBOUND" ? this.info.to : this.info.from, at: Date.now(),
    });
    try {
      await plivo.transferCall(this.callUuid, `${config.publicUrl}/plivo/transfer-xml?t=${token}`);
      log.info("transferred to staff", { callId: this.session.callId });
      await this.finish("transferred", false);
    } catch (e) {
      log.error("transfer failed", { err: (e as Error).message });
      this.transferring = false;
      this.messages.push({ role: "system", content: "The transfer failed. Apologize and offer to take a message with save_inquiry." });
      this.respond();
    }
  }

  async hangup(): Promise<void> {
    try { await plivo.hangupCall(this.callUuid); } catch (e) { log.warn("hangup failed", { err: (e as Error).message }); }
    await this.finish("ended by AI");
  }

  // ---------------- end of call ----------------

  private transcript(): string {
    const lines: string[] = [];
    for (const m of this.messages) {
      if ((m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim()) {
        lines.push(`${m.role === "user" ? "Caller" : "AI"}: ${m.content.trim()}`);
      }
    }
    return lines.join("\n");
  }

  /** Average reply latency in ms (caller stops talking -> first audio), for tests and logs. */
  get avgLatencyMs(): number | null {
    return this.latencies.length ? Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length) : null;
  }

  async finish(reason: string, closeSocket = true): Promise<void> {
    if (this.finished || !this.session) return;
    this.finished = true;
    this.cancelPendingCommit();
    if (this.maxTimer) clearTimeout(this.maxTimer);
    if (this.thinkTimer) clearTimeout(this.thinkTimer);
    this.abort?.abort();
    this.stt.close();
    this.tts.close();
    if (closeSocket) try { this.ws.close(); } catch { /* ignore */ }
    const transcript = this.transcript();
    const summary = await summarize(transcript);
    await api.endCall(this.session.callId, transcript, summary, Math.round((Date.now() - this.started) / 1000));
    log.info("call ended", { callId: this.session.callId, reason, avgReplyMs: this.avgLatencyMs });
  }
}
