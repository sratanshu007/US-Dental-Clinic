// OpenAI-compatible chat completions (OpenAI, xAI Grok, Azure OpenAI via base URL), streaming with tool calls.
import { config } from "./config";
import type { ToolDef } from "./tools";

export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }

export type LlmEvent = { type: "text"; delta: string } | { type: "done"; toolCalls: ToolCall[]; text: string };

export async function* chatStream(messages: Message[], tools: ToolDef[], signal: AbortSignal): AsyncGenerator<LlmEvent> {
  const r = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.llm.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.llm.model, messages, tools, tool_choice: "auto", stream: true,
      temperature: config.llm.temperature, max_tokens: config.llm.maxTokens,
    }),
    signal,
  });
  if (!r.ok || !r.body) throw new Error(`LLM request failed (${r.status})`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  const calls: ToolCall[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let j: any;
      try { j = JSON.parse(data); } catch { continue; }
      const d = j.choices?.[0]?.delta;
      if (!d) continue;
      if (typeof d.content === "string" && d.content) { text += d.content; yield { type: "text", delta: d.content }; }
      for (const tc of d.tool_calls ?? []) {
        const i = tc.index ?? 0;
        calls[i] ??= { id: tc.id ?? `call_${i}`, type: "function", function: { name: "", arguments: "" } };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].function.name += tc.function.name;
        if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
      }
    }
  }
  yield { type: "done", toolCalls: calls.filter(Boolean), text };
}

/** Two-sentence summary for the clinic dashboard (same BAA-covered vendor). */
export async function summarize(transcript: string): Promise<string | null> {
  if (!transcript || !config.llm.apiKey) return null;
  try {
    const r = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.llm.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.llm.summaryModel, max_tokens: 120,
        messages: [
          { role: "system", content: "Summarize this dental clinic phone call for the front desk in at most two short sentences: who called, what they wanted, and what was done or still needs follow-up. No extra health details." },
          { role: "user", content: transcript.slice(0, 12000) },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    return j.choices?.[0]?.message?.content?.trim() ?? null;
  } catch { return null; }
}

/**
 * Split streamed text into speakable pieces as soon as each is complete. The first piece of a reply may
 * end at a comma (once it's long enough), so the caller hears the start of the answer sooner.
 */
export class SentenceSplitter {
  private buf = "";
  private emitted = 0;
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    const re = /([.!?])(\s+)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.buf))) {
      const candidate = this.buf.slice(last, m.index + 1).trim();
      if (/\b(Dr|Mr|Mrs|Ms|St|Jr|Sr)\.$/.test(candidate) || candidate.length < 8) continue;
      out.push(candidate);
      last = m.index + m[0].length;
    }
    this.buf = this.buf.slice(last);
    // Early first clause: "Sure, let me check that for you, " -> speak "Sure, let me check that for you,"
    if (this.emitted === 0 && out.length === 0) {
      const c = this.buf.search(/[,;:—–]\s/);
      if (c >= 24) {
        out.push(this.buf.slice(0, c + 1).trim());
        this.buf = this.buf.slice(c + 2);
      }
    }
    this.emitted += out.length;
    return out;
  }
  flush(): string | null {
    const s = this.buf.trim();
    this.buf = "";
    return s || null;
  }
}
