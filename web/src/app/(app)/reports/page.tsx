"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { addDays, fmtPhone, fmtTime, patientName } from "@/lib/api";
import FilterBar, { useFilters } from "@/components/FilterBar";
import { Badge, ErrorBox, Loading, useApi } from "@/components/ui";

function Report() {
  const params = useSearchParams();
  const [date, setDate] = useState(params.get("date") ?? "");
  const { data, error, loading } = useApi<any>(`/api/reports/daily${date ? `?date=${date}` : ""}`);
  const s = data?.summary;
  const day = date || s?.date;

  const f = useFilters();
  const dentists = [...new Map((data?.appointments ?? []).filter((a: any) => a.provider).map((a: any) => [a.provider.id, a.provider.name])).entries()] as [string, string][];
  const appts = (data?.appointments ?? []).filter((a: any) => !f.values.provider || a.provider?.id === f.values.provider);
  const came = appts.filter((a: any) => a.status === "SHOWED");
  const missed = appts.filter((a: any) => a.status === "NO_SHOW");
  const unmarked = appts.filter((a: any) => a.status === "BOOKED" || a.status === "CONFIRMED");

  const List = ({ title, rows }: { title: string; rows: any[] }) => (
    <div className="card">
      <h2>{title} ({rows.length})</h2>
      {rows.length === 0 ? <div className="muted">None</div> : (
        <table><tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              <td style={{ width: 90 }}>{fmtTime(a.startAt)}</td>
              <td><Link href={`/patients/${a.patient.id}`}>{patientName(a.patient)}</Link><div className="small muted">{fmtPhone(a.patient.phone)}</div></td>
              <td className="muted">{a.service?.name ?? a.reason ?? ""}</td>
              <td><Badge value={a.status} /></td>
            </tr>
          ))}
        </tbody></table>
      )}
    </div>
  );

  return (
    <>
      <div className="page-head">
        <div><h1>Daily report</h1><div className="muted">Who came, who didn&apos;t, and what the AI did. Sent to your phone every evening.</div></div>
        {day && (
          <div className="row">
            <button onClick={() => setDate(addDays(day, -1))}>←</button>
            <input type="date" value={day} onChange={(e) => setDate(e.target.value)} style={{ width: 170 }} />
            <button onClick={() => setDate(addDays(day, 1))}>→</button>
            <button onClick={() => window.print()}>Print</button>
          </div>
        )}
      </div>
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : s && (
        <>
          <div className="grid k4" style={{ marginBottom: 14 }}>
            <div className="card stat"><div className="label">Scheduled</div><div className="value">{s.scheduled}</div></div>
            <div className="card stat"><div className="label">Came</div><div className="value" style={{ color: "var(--green)" }}>{s.showed}</div></div>
            <div className="card stat"><div className="label">No-show</div><div className="value" style={{ color: "var(--red)" }}>{s.noShow}</div></div>
            <div className="card stat"><div className="label">Not marked</div><div className="value">{s.unmarked}</div></div>
          </div>
          <div className="grid k4" style={{ marginBottom: 14 }}>
            <div className="card stat"><div className="label">AI bookings</div><div className="value">{s.newBookingsByAi}</div></div>
            <div className="card stat"><div className="label">Calls handled</div><div className="value">{s.callsHandled}</div></div>
            <div className="card stat"><div className="label">New inquiries</div><div className="value">{s.newLeads}</div></div>
            <div className="card stat"><div className="label">Avg rating</div><div className="value">{s.avgRating ?? "—"}</div><div className="hint">{s.feedbackCount} responses</div></div>
          </div>
          {dentists.length > 1 && (
            <div className="card" style={{ padding: 0, marginBottom: 14 }}>
              <FilterBar values={f.values} onChange={f.set} onClear={f.clear} active={f.active} shown={appts.length} total={data?.appointments.length}
                defs={[{ key: "provider", type: "chips", options: [["", "All dentists"], ...dentists] }]} />
            </div>
          )}
          <div className="grid k3">
            <List title="Came" rows={came} />
            <List title="No-show" rows={missed} />
            <List title="Not marked" rows={unmarked} />
          </div>
        </>
      )}
    </>
  );
}

export default function Page() {
  return <Suspense><Report /></Suspense>;
}
