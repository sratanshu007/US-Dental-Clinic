"use client";

import { useMemo, useState } from "react";

interface Message {
  id: number;
  speaker: "AI" | "CALLER" | "SYSTEM";
  text: string;
}

export function parseTranscript(raw: string | null | undefined): Message[] {
  if (!raw || !raw.trim()) return [];

  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const messages: Message[] = [];
  let currentMsg: Message | null = null;
  let counter = 1;

  for (const line of lines) {
    const trimmed = line.trim();
    const callerMatch = trimmed.match(/^(caller|patient|user)\s*:\s*(.*)$/i);
    const aiMatch = trimmed.match(/^(ai|receptionist|assistant|bot)\s*:\s*(.*)$/i);

    if (callerMatch) {
      if (currentMsg) messages.push(currentMsg);
      currentMsg = { id: counter++, speaker: "CALLER", text: callerMatch[2].trim() };
    } else if (aiMatch) {
      if (currentMsg) messages.push(currentMsg);
      currentMsg = { id: counter++, speaker: "AI", text: aiMatch[2].trim() };
    } else if (currentMsg) {
      // Continuation of previous speaker turn
      currentMsg.text += "\n" + trimmed;
    } else {
      // General note or intro line
      messages.push({ id: counter++, speaker: "SYSTEM", text: trimmed });
    }
  }

  if (currentMsg) messages.push(currentMsg);
  return messages;
}

export default function TranscriptViewer({
  transcript,
  callerName,
}: {
  transcript: string | null | undefined;
  callerName?: string;
}) {
  const [filter, setFilter] = useState<"ALL" | "AI" | "CALLER">("ALL");
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);

  const messages = useMemo(() => parseTranscript(transcript), [transcript]);

  const filtered = useMemo(() => {
    return messages.filter((m) => {
      if (filter === "AI" && m.speaker !== "AI") return false;
      if (filter === "CALLER" && m.speaker !== "CALLER") return false;
      if (query.trim() && !m.text.toLowerCase().includes(query.toLowerCase())) return false;
      return true;
    });
  }, [messages, filter, query]);

  const handleCopy = async () => {
    if (!transcript) return;
    try {
      await navigator.clipboard.writeText(transcript);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  if (!transcript || messages.length === 0) {
    return (
      <div className="transcript-empty-card">
        <div className="transcript-empty-icon">🎙️</div>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>No Call Transcript Recorded</div>
        <div className="muted small" style={{ maxWidth: 360, margin: "0 auto" }}>
          Transcripts are automatically generated and encrypted after every phone call. They are deleted automatically after your clinic&apos;s retention period.
        </div>
      </div>
    );
  }

  return (
    <div className="transcript-container">
      {/* Top Toolbar */}
      <div className="transcript-toolbar">
        <div className="transcript-filter-group">
          <button
            type="button"
            className={`transcript-pill ${filter === "ALL" ? "active" : ""}`}
            onClick={() => setFilter("ALL")}
          >
            All ({messages.length})
          </button>
          <button
            type="button"
            className={`transcript-pill ${filter === "AI" ? "active" : ""}`}
            onClick={() => setFilter("AI")}
          >
            AI only
          </button>
          <button
            type="button"
            className={`transcript-pill ${filter === "CALLER" ? "active" : ""}`}
            onClick={() => setFilter("CALLER")}
          >
            Caller only
          </button>
        </div>

        <div className="transcript-actions">
          <input
            type="search"
            placeholder="Search transcript..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="transcript-search"
          />
          <button
            type="button"
            onClick={handleCopy}
            className="btn small"
            title="Copy full transcript"
            style={{ minWidth: 70 }}
          >
            {copied ? "✓ Copied" : "📋 Copy"}
          </button>
        </div>
      </div>

      {/* Messages Feed */}
      <div className="transcript-feed">
        {filtered.length === 0 ? (
          <div className="empty small">No dialogue matches your search query.</div>
        ) : (
          filtered.map((m) => {
            const isAi = m.speaker === "AI";

            if (m.speaker === "SYSTEM") {
              return (
                <div key={m.id} className="transcript-system-msg">
                  <span>{m.text}</span>
                </div>
              );
            }

            return (
              <div
                key={m.id}
                className={`transcript-turn ${isAi ? "turn-ai" : "turn-caller"}`}
              >
                <div className="transcript-avatar">
                  {isAi ? "🤖" : "👤"}
                </div>
                <div className="transcript-content">
                  <div className="transcript-speaker-row">
                    <span className="transcript-speaker-name">
                      {isAi ? "AI Receptionist" : callerName || "Patient / Caller"}
                    </span>
                    <span className="transcript-speaker-badge">
                      {isAi ? "AI Agent" : "Caller"}
                    </span>
                  </div>
                  <div className="transcript-bubble">
                    {m.text}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer info */}
      <div className="transcript-footer">
        <span>🔒 AES-256-GCM Encrypted at Rest (HIPAA Compliant)</span>
        <span>{messages.length} total messages</span>
      </div>
    </div>
  );
}
