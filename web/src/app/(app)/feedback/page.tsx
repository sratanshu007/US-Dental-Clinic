"use client";

import Link from "next/link";
import { fmtDateTime, patientName } from "@/lib/api";
import FilterBar, { useFilters } from "@/components/FilterBar";
import { ErrorBox, Loading, Stars, useApi } from "@/components/ui";

export default function Feedback() {
  const all = useApi<any[]>("/api/feedback");
  const fl = useFilters();
  const { data, error, loading } = useApi<any[]>(`/api/feedback${fl.query ? `?${fl.query}` : ""}`);
  const rated = (all.data ?? []).filter((f) => f.rating);
  const avg = rated.length ? (rated.reduce((s, f) => s + f.rating, 0) / rated.length).toFixed(1) : "—";
  const low = rated.filter((f) => f.rating <= 3).length;

  return (
    <>
      <div className="page-head"><div><h1>Patient feedback</h1><div className="muted">Collected by the AI after each visit (call or text).</div></div></div>
      <div className="grid k3" style={{ marginBottom: 14 }}>
        <div className="card stat"><div className="label">Average rating</div><div className="value">{avg}</div></div>
        <div className="card stat"><div className="label">Responses</div><div className="value">{all.data?.length ?? 0}</div></div>
        <div className="card stat"><div className="label">Needs attention (≤3)</div><div className="value" style={{ color: low ? "var(--red)" : undefined }}>{low}</div></div>
      </div>
      <ErrorBox error={error} />
      <div className="card" style={{ padding: 0 }}>
        <FilterBar
          values={fl.values} onChange={fl.set} onClear={fl.clear} active={fl.active} shown={data?.length} total={all.data?.length}
          defs={[
            { key: "q", type: "search", label: "Search patient or comment" },
            { key: "rating", type: "chips", options: [["", "All ratings"], ["high", "4–5 ★"], ["low", "1–3 ★ needs attention"]] },
            { key: "channel", type: "select", label: "Call & text", options: [["CALL", "Phone call"], ["SMS", "Text message"]] },
          ]}
        />
        {loading && !data ? <Loading /> : !data?.length ? <div className="empty">No feedback matches.</div> : (
          <table>
            <thead><tr><th>When</th><th>Patient</th><th>Rating</th><th>Comment</th><th>Via</th></tr></thead>
            <tbody>
              {data.map((f) => (
                <tr key={f.id}>
                  <td className="muted" style={{ whiteSpace: "nowrap" }}>{fmtDateTime(f.createdAt)}</td>
                  <td><Link href={`/patients/${f.patient.id}`}>{patientName(f.patient)}</Link></td>
                  <td><Stars n={f.rating} /></td>
                  <td>{f.comment ?? <span className="muted">—</span>}</td>
                  <td className="small">{f.channel === "CALL" ? "Call" : "Text"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
