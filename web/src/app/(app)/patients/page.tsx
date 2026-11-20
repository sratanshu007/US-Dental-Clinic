"use client";

import { useRouter } from "next/navigation";
import { fmtDateTime, fmtPhone, patientName } from "@/lib/api";
import FilterBar, { useFilters } from "@/components/FilterBar";
import { Avatar, ErrorBox, Loading, useApi } from "@/components/ui";

export default function Patients() {
  const router = useRouter();
  const f = useFilters();
  const { data, error, loading } = useApi<any[]>(`/api/patients${f.query ? `?${f.query}` : ""}`);

  return (
    <>
      <div className="page-head"><div><h1>Patients</h1><div className="muted">Everyone who called or booked.</div></div></div>
      <ErrorBox error={error} />
      <div className="card" style={{ padding: 0 }}>
        <FilterBar
          values={f.values} onChange={f.set} onClear={f.clear} active={f.active} shown={data?.length}
          defs={[
            { key: "q", type: "search", label: "Search name or phone" },
            { key: "type", type: "select", label: "New & existing", options: [["new", "New patients"], ["existing", "Existing patients"]] },
            { key: "consent", type: "select", label: "Any consent", options: [["all", "Texts + calls OK"], ["nosms", "No text consent"], ["nocall", "No call consent"], ["optout", "Opted out of texts"]] },
            { key: "upcoming", type: "select", label: "Next visit: any", options: [["yes", "Has upcoming visit"], ["no", "No upcoming visit"]] },
          ]}
        />
        {loading && !data ? <Loading /> : !data?.length ? <div className="empty">No patients found.</div> : (
          <table>
            <thead><tr><th>Name</th><th>Phone</th><th>Texts</th><th>Calls</th><th>Next visit</th></tr></thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => router.push(`/patients/${p.id}`)}>
                  <td><div className="row" style={{ gap: 8 }}><Avatar name={patientName(p)} size={28} /> {patientName(p)} {p.isNew && <span className="badge">new</span>}</div></td>
                  <td>{fmtPhone(p.phone)}</td>
                  <td>{p.smsOptOut ? <span className="badge NO_SHOW">opted out</span> : p.smsConsent ? "Yes" : "No"}</td>
                  <td>{p.callConsent ? "Yes" : "No"}</td>
                  <td className="muted">{p.nextAppointmentAt ? fmtDateTime(p.nextAppointmentAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
