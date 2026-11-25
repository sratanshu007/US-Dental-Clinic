// Deepgram Aura text-to-speech as 8 kHz mu-law (the format Plivo plays) — no transcoding anywhere.
//
//  * TtsStream: one WebSocket per call. Sentences are sent as soon as the LLM finishes them and audio
//    streams back immediately, with no new HTTPS connection per sentence. Barge-in sends "Clear".
//  * cachedAudio: fixed phrases (greeting, "let me check") are synthesized once and reused, so they
//    play instantly.
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { config } from "./config";
import { log } from "./log";

const query = () => new URLSearchParams({
  model: config.deepgram.voice, encoding: "mulaw", sample_rate: "8000", mip_opt_out: "true",
});

/** One-shot synthesis over HTTPS (used for cached phrases and as a fallback). */
export async function* speak(text: string, signal: AbortSignal): AsyncGenerator<Buffer> {
  const q = query();
  q.set("container", "none");
  const r = await fetch(`${config.deepgram.apiUrl}/speak?${q}`, {
    method: "POST",
    headers: { Authorization: `Token ${config.deepgram.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!r.ok || !r.body) throw new Error(`Deepgram TTS failed (${r.status})`);
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.length) yield Buffer.from(value);
  }
}

// ---------------- phrase cache ----------------
const cache = new Map<string, Promise<Buffer>>();
const MAX_CACHE = 300;

/** Audio for a fixed phrase, synthesized once per voice and kept in memory. */
export function cachedAudio(text: string): Promise<Buffer> {
  const key = `${config.deepgram.voice}|${text}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const parts: Buffer[] = [];
      for await (const c of speak(text, AbortSignal.timeout(10_000))) parts.push(c);
      return Buffer.concat(parts);
    })();
    p.catch(() => cache.delete(key));
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
    cache.set(key, p);
  }
  return p;
}

// Short bridges a person says before looking something up. Chosen per tool, rotated so they don't repeat.
export const FILLERS: Record<string, string[]> = {
  check_availability: ["Let me check what's open.", "Sure, let me take a look.", "One sec, let me check the schedule."],
  book_appointment: ["Perfect, let me book that.", "Great, one moment while I put that in.", "Okay, booking that now."],
  verify_caller: ["Thanks, one moment.", "Got it, let me pull that up.", "Thank you, one sec."],
  find_my_appointments: ["Let me pull that up.", "One moment.", "Sure, let me look."],
  reschedule_appointment: ["Okay, moving that now.", "Sure, one moment.", "Got it, let me change that."],
  cancel_appointment: ["Okay, one moment.", "Sure, let me take care of that."],
  default: ["One moment.", "Sure, one sec.", "Okay, just a moment."],
};

// Said only if the LLM is slow to start answering, like a person going "mm-hmm" while they think
export const THINKING = ["Mm-hmm.", "Okay.", "Sure.", "Alright."];

/** Warm the cache at start-up so the first caller of the day doesn't wait either. */
export function warmFillers(): void {
  if (!config.deepgram.apiKey) return;
  const all = new Set([
    ...Object.values(FILLERS).flat(),
    ...THINKING,
    "Thank you for calling Demo Family Dental! This call's recorded for monitoring purposes, and I'm the clinic's AI assistant. How can I help you today?",
  ]);
  for (const t of all) cachedAudio(t).catch(() => {});
}

// ---------------- streaming socket ----------------
export interface TtsEvents { audio: [chunk: Buffer]; error: [err: Error] }

export class TtsStream extends EventEmitter<TtsEvents> {
  private ws: WebSocket | null = null;
  private open = false;
  private failed = false;
  private clearing = false;
  private waiters: Array<() => void> = [];
  private outbox: string[] = [];
  private clearTimer: NodeJS.Timeout | undefined;

  connect(): void {
    const ws = new WebSocket(`${config.deepgram.wsUrl.replace(/\/listen$/, "/speak")}?${query()}`, {
      headers: { Authorization: `Token ${config.deepgram.apiKey}` },
    });
    this.ws = ws;
    ws.on("open", () => {
      this.open = true;
      for (const m of this.outbox.splice(0)) ws.send(m);
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        if (!this.clearing) this.emit("audio", data as Buffer);
        return;
      }
      let m: any;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === "Flushed") this.waiters.shift()?.();
      else if (m.type === "Cleared") { this.clearing = false; clearTimeout(this.clearTimer); }
      else if (m.type === "Warning" || m.type === "Error") log.warn("tts stream message", { type: m.type, code: m.err_code ?? m.code });
    });
    const fail = (e?: Error) => {
      if (this.failed) return;
      this.failed = true;
      this.open = false;
      for (const w of this.waiters.splice(0)) w();
      if (e) this.emit("error", e);
    };
    ws.on("error", (e) => fail(e as Error));
    ws.on("close", () => fail());
  }

  /** True when the socket can't be used (caller should fall back to HTTPS synthesis). */
  get unavailable(): boolean { return this.failed || !this.ws; }

  private send(obj: unknown) {
    const m = JSON.stringify(obj);
    if (this.open && this.ws?.readyState === WebSocket.OPEN) this.ws.send(m);
    else this.outbox.push(m);
  }

  /** Synthesize a sentence; resolves when all its audio has been received. */
  say(text: string): Promise<void> {
    if (this.unavailable) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      this.send({ type: "Speak", text });
      this.send({ type: "Flush" });
      // Never hang a call on a lost reply
      setTimeout(resolve, 15_000).unref();
    });
  }

  /** Barge-in: drop anything not yet received. */
  clear(): void {
    if (this.unavailable) return;
    this.clearing = true; // drop late audio from the cut-off reply until Deepgram confirms "Cleared"
    this.outbox = this.outbox.filter((m) => !m.includes('"Speak"') && !m.includes('"Flush"'));
    for (const w of this.waiters.splice(0)) w();
    this.send({ type: "Clear" });
    clearTimeout(this.clearTimer);
    this.clearTimer = setTimeout(() => (this.clearing = false), 1500);
  }

  close(): void {
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "Close" }));
      this.ws?.close();
    } catch { /* ignore */ }
    this.failed = true;
  }
}
