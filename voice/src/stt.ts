// Deepgram live speech-to-text over WebSocket (8 kHz mu-law straight from Plivo, no re-encoding).
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { config } from "./config";

export interface SttEvents {
  speechStarted: [];
  interim: [text: string];
  final: [text: string, speechFinal: boolean];
  utteranceEnd: [];
  error: [err: Error];
}

export class DeepgramStt extends EventEmitter<SttEvents> {
  private ws: WebSocket | null = null;
  private keepAlive: NodeJS.Timeout | null = null;
  private queue: Buffer[] = [];
  private closed = false;

  connect(): void {
    const q = new URLSearchParams({
      model: config.deepgram.sttModel,
      encoding: "mulaw",
      sample_rate: "8000",
      channels: "1",
      interim_results: "true",
      endpointing: String(config.deepgram.endpointingMs),
      utterance_end_ms: "1000",
      vad_events: "true",
      smart_format: "true",
      punctuate: "true",
      language: "multi", // English + Spanish callers
      mip_opt_out: "true", // vendor may not use call audio to train models
    });
    const ws = new WebSocket(`${config.deepgram.wsUrl}?${q}`, { headers: { Authorization: `Token ${config.deepgram.apiKey}` } });
    this.ws = ws;
    ws.on("open", () => {
      for (const b of this.queue.splice(0)) ws.send(b);
      this.keepAlive = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "KeepAlive" })), 4000);
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let m: any;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === "SpeechStarted") this.emit("speechStarted");
      else if (m.type === "UtteranceEnd") this.emit("utteranceEnd");
      else if (m.type === "Results") {
        const text: string = (m.channel?.alternatives?.[0]?.transcript ?? "").trim();
        if (!text) {
          if (m.speech_final) this.emit("final", "", true);
          return;
        }
        if (m.is_final) this.emit("final", text, !!m.speech_final);
        else this.emit("interim", text);
      }
    });
    ws.on("error", (e) => {
      if (!this.closed) this.emit("error", e as Error);
    });
    ws.on("close", () => {
      if (this.keepAlive) clearInterval(this.keepAlive);
      if (!this.closed) this.emit("error", new Error("Deepgram STT closed"));
    });
  }

  send(audio: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(audio);
    else if (this.queue.length < 250) this.queue.push(audio); // ~5 s while connecting
  }

  close(): void {
    this.closed = true;
    if (this.keepAlive) clearInterval(this.keepAlive);
    try {
      this.ws?.removeAllListeners("error");
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "CloseStream" }));
      this.ws?.close();
    } catch { /* ignore */ }
  }
}
