"use client";

import Link from "next/link";
import { use } from "react";
import { fmtDateTime, fmtPhone, patientName } from "@/lib/api";
import { ErrorBox, Loading, useApi } from "@/components/ui";

export default function CallPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: c, error } = useApi<any>(`/api/calls/${id}`);
  if (!c) return error ? <ErrorBox error={error} /> : <Loading />;
  return (
    <>
      <div className="page-head">
        <div>
          <Link href="/calls" className="small">← Calls</Link>
          <h1>{c.direction === "INBOUND" ? "Incoming call" : "AI outbound call"}</h1>
          <div className="muted">
            {fmtDateTime(c.startedAt)} · {c.durationSec ? `${Math.round(c.durationSec / 60)} min` : "—"} · {fmtPhone(c.direction === "INBOUND" ? c.fromNumber : c.toNumber)}
          </div>
        </div>
      </div>
      <div className="grid k2">
        <div className="card">
          <h2>Summary</h2>
          <p>{c.summary ?? <span className="muted">No summary.</span>}</p>
          <div className="small muted">Result: {c.outcome ?? "—"}</div>
          {c.patient && <p>Patient: <Link href={`/patients/${c.patient.id}`}>{patientName(c.patient)}</Link></p>}
        </div>
        <div className="card">
          <h2>Transcript</h2>
          {c.transcript ? <div className="transcript">{c.transcript}</div> : <div className="muted">No transcript (may have been deleted after the retention period).</div>}
        </div>
      </div>
    </>
  );
}
