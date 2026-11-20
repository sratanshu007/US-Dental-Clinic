"use client";

import Link from "next/link";
import { use } from "react";
import { fmtDateTime, fmtPhone, patientName } from "@/lib/api";
import { Badge, ErrorBox, Loading, useApi } from "@/components/ui";
import TranscriptViewer from "@/components/TranscriptViewer";

export default function CallPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: c, error } = useApi<any>(`/api/calls/${id}`);
  if (!c) return error ? <ErrorBox error={error} /> : <Loading />;

  const callerDisplayName = c.patient
    ? patientName(c.patient)
    : fmtPhone(c.direction === "INBOUND" ? c.fromNumber : c.toNumber);

  const durationText = c.durationSec
    ? `${Math.floor(c.durationSec / 60)}m ${String(c.durationSec % 60).padStart(2, "0")}s`
    : "—";

  return (
    <>
      <div className="page-head">
        <div>
          <Link href="/calls" className="small" style={{ display: "inline-flex", alignItems: "center", gap: 4, marginBottom: 6 }}>
            ← Back to Calls
          </Link>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h1 style={{ margin: 0 }}>
              {c.direction === "INBOUND" ? "Incoming Call" : "AI Outbound Call"}
            </h1>
            <Badge value={c.direction} label={c.direction === "INBOUND" ? "Inbound" : "Outbound"} />
            {c.outcome && <Badge value={c.outcome} />}
          </div>
          <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>
            {fmtDateTime(c.startedAt)} · Duration: <strong>{durationText}</strong> · Caller: <strong>{callerDisplayName}</strong>
          </div>
        </div>
      </div>

      <div className="call-detail-grid">
        {/* Left Column: Call Info & Summary */}
        <div className="call-info-col">
          <div className="card">
            <h2>AI Call Summary</h2>
            {c.summary ? (
              <div className="call-summary-box">
                <span className="summary-quote-icon">“</span>
                <p style={{ margin: 0, fontStyle: "italic", lineHeight: 1.5 }}>{c.summary}</p>
              </div>
            ) : (
              <div className="muted small" style={{ fontStyle: "italic" }}>
                No summary generated for this call.
              </div>
            )}

            <div style={{ marginTop: 20, borderTop: "1px solid var(--line)", paddingTop: 16 }}>
              <h3 style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--muted)", marginBottom: 12 }}>
                Call Information
              </h3>
              <div className="call-meta-list">
                <div className="call-meta-row">
                  <span className="muted">Purpose</span>
                  <span style={{ fontWeight: 600 }}>{c.purpose?.replace(/_/g, " ")}</span>
                </div>
                <div className="call-meta-row">
                  <span className="muted">Call Result</span>
                  <span>{c.outcome ? <Badge value={c.outcome} /> : "—"}</span>
                </div>
                <div className="call-meta-row">
                  <span className="muted">Duration</span>
                  <span>{durationText}</span>
                </div>
                <div className="call-meta-row">
                  <span className="muted">From Number</span>
                  <span>{fmtPhone(c.fromNumber)}</span>
                </div>
                <div className="call-meta-row">
                  <span className="muted">To Number</span>
                  <span>{fmtPhone(c.toNumber)}</span>
                </div>
                {c.patient && (
                  <div className="call-meta-row">
                    <span className="muted">Linked Patient</span>
                    <Link href={`/patients/${c.patient.id}`} style={{ fontWeight: 600 }}>
                      {patientName(c.patient)} →
                    </Link>
                  </div>
                )}
                {c.appointmentId && (
                  <div className="call-meta-row">
                    <span className="muted">Appointment</span>
                    <Link href="/appointments" style={{ fontWeight: 600 }}>
                      View Appointment →
                    </Link>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Interactive Transcript */}
        <div className="call-transcript-col">
          <div className="card" style={{ padding: 0 }}>
            <div style={{ padding: "16px 20px 12px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 18 }}>🎙️</span>
                <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Dialogue & Call Transcript</h2>
              </div>
            </div>
            <TranscriptViewer
              transcript={c.transcript}
              callerName={c.patient ? patientName(c.patient) : "Caller"}
            />
          </div>
        </div>
      </div>
    </>
  );
}
