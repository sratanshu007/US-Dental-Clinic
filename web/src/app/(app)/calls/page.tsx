"use client";

import { useRouter } from "next/navigation";
import { addDays, fmtDateTime, fmtPhone, patientName, todayISO } from "@/lib/api";
import FilterBar, { useFilters } from "@/components/FilterBar";
import { Badge, ErrorBox, Loading, useApi } from "@/components/ui";

const PURPOSE: Record<string, string> = { RECEPTION: "Reception", NO_SHOW_REBOOK: "No-show rebook", FEEDBACK: "Feedback" };
const OUTCOMES = ["BOOKED", "RESCHEDULED", "CANCELLED", "LEAD", "TRANSFERRED", "FEEDBACK", "INFO", "NO_ANSWER"];

export default function Calls() {
  const router = useRouter();
  const f = useFilters();
  const { when, ...rest } = f.values;
  const q = new URLSearchParams(Object.entries(rest).filter(([, v]) => v) as [string, string][]);
  if (when === "today") q.set("from", todayISO());
  if (when === "7d") q.set("from", addDays(todayISO(), -6));
  if (when === "30d") q.set("from", addDays(todayISO(), -29));
  const { data, error, loading } = useApi<any[]>(`/api/calls${q.toString() ? `?${q}` : ""}`);
  return (
    <>
      <div className="page-head"><div><h1>Calls</h1><div className="muted">Every call the AI answered or made, with summary and transcript.</div></div></div>
      <ErrorBox error={error} />
      <div className="card" style={{ padding: 0 }}>
        <FilterBar
          values={f.values} onChange={f.set} onClear={f.clear} active={f.active} shown={data?.length}
          defs={[
            { key: "q", type: "search", label: "Search caller name or number" },
            { key: "when", type: "select", label: "Any date", options: [["today", "Today"], ["7d", "Last 7 days"], ["30d", "Last 30 days"]] },
            { key: "direction", type: "select", label: "In & out", options: [["INBOUND", "Incoming"], ["OUTBOUND", "AI outbound"]] },
            { key: "purpose", type: "select", label: "Any purpose", options: Object.entries(PURPOSE) },
            { key: "outcome", type: "select", label: "Any result", options: OUTCOMES.map((o) => [o, o.replace("_", " ").toLowerCase()]) },
          ]}
        />
        {loading && !data ? <Loading /> : !data?.length ? <div className="empty">No calls match.</div> : (
          <table>
            <thead><tr><th>When</th><th>Type</th><th>Caller</th><th>Purpose</th><th>Result</th><th>Length</th></tr></thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => router.push(`/calls/${c.id}`)}>
                  <td>{fmtDateTime(c.startedAt)}</td>
                  <td><Badge value={c.direction} label={c.direction === "INBOUND" ? "incoming" : "outbound"} /></td>
                  <td>{c.patient ? patientName(c.patient) : fmtPhone(c.direction === "INBOUND" ? c.fromNumber : c.toNumber)}</td>
                  <td>{PURPOSE[c.purpose]}</td>
                  <td>{c.outcome ? <span className="badge">{c.outcome.toLowerCase()}</span> : "—"}</td>
                  <td className="muted">{c.durationSec ? `${Math.floor(c.durationSec / 60)}:${String(c.durationSec % 60).padStart(2, "0")}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
