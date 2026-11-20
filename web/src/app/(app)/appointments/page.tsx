"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { addDays, api, fmtDate, fmtPhone, fmtTime, patientName, todayISO } from "@/lib/api";
import BookingModal from "@/components/BookingModal";
import FilterBar, { useFilters } from "@/components/FilterBar";
import { Badge, ErrorBox, Loading, useApi } from "@/components/ui";

function Appointments() {
  const params = useSearchParams();
  const settings = useApi<any>("/api/settings");
  const tz = settings.data?.clinic.timezone as string | undefined;
  const [date, setDate] = useState<string>("");
  const [range, setRange] = useState<"day" | "week">("day");
  const [showNew, setShowNew] = useState(params.get("new") === "1");
  const [resched, setResched] = useState<any | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (tz && !date) setDate(todayISO(tz));
  }, [tz, date]);

  const to = date ? (range === "day" ? date : addDays(date, 6)) : "";
  const f = useFilters();
  const list = useApi<any[]>(date ? `/api/appointments?from=${date}&to=${to}${f.query ? `&${f.query}` : ""}` : null);

  async function setStatus(id: string, status: string) {
    setBusyId(id);
    setError(null);
    try {
      await api(`/api/appointments/${id}/status`, { method: "PATCH", body: { status } });
      await list.reload();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  }

  if (!settings.data || !date) return <Loading />;
  const { services, providers } = settings.data;
  const now = Date.now();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Appointments</h1>
          <div className="muted">Mark who came and who didn&apos;t. No-shows get an AI call to rebook; patients who came get a feedback call.</div>
        </div>
        <button className="primary" onClick={() => setShowNew(true)}>+ New appointment</button>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row">
          <button onClick={() => setDate(addDays(date, range === "day" ? -1 : -7))}>←</button>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 170 }} />
          <button onClick={() => setDate(addDays(date, range === "day" ? 1 : 7))}>→</button>
          <button onClick={() => setDate(todayISO(tz))}>Today</button>
          <div className="grow" />
          <select value={range} onChange={(e) => setRange(e.target.value as "day" | "week")} style={{ width: 120 }}>
            <option value="day">Day</option>
            <option value="week">7 days</option>
          </select>
        </div>
      </div>

      <ErrorBox error={error || list.error} />
      <div className="card" style={{ padding: 0 }}>
        <FilterBar
          values={f.values} onChange={f.set} onClear={f.clear} active={f.active} shown={list.data?.length}
          defs={[
            { key: "q", type: "search", label: "Search patient, phone, service" },
            { key: "status", type: "select", label: "All statuses", options: [["OPEN", "Waiting / not marked"], ["BOOKED", "Booked"], ["CONFIRMED", "Confirmed"], ["SHOWED", "Came"], ["NO_SHOW", "No-show"], ["CANCELLED", "Cancelled"], ["RESCHEDULED", "Rescheduled"]] },
            { key: "providerId", type: "select", label: "All dentists", options: providers.map((p: any) => [p.id, p.name]) },
            { key: "source", type: "select", label: "Booked by: anyone", options: [["AI", "AI receptionist"], ["STAFF", "Staff"]] },
          ]}
        />
        {list.loading && !list.data ? <Loading /> : !list.data?.length ? (
          <div className="empty">No appointments match.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Time</th><th>Patient</th><th>Service</th><th>Dentist</th><th>Booked by</th><th>Status</th><th style={{ textAlign: "right" }}>Mark</th></tr>
            </thead>
            <tbody>
              {list.data.map((a) => {
                const started = new Date(a.startAt).getTime() <= now;
                const open = a.status === "BOOKED" || a.status === "CONFIRMED";
                return (
                  <tr key={a.id}>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {range === "week" && <div className="small muted">{fmtDate(a.startAt, tz)}</div>}
                      <b>{fmtTime(a.startAt, tz)}</b>
                    </td>
                    <td>
                      <Link href={`/patients/${a.patient.id}`}>{patientName(a.patient)}</Link>
                      {a.patient.isNew && <span className="badge" style={{ marginLeft: 6 }}>new</span>}
                      <div className="small muted">{fmtPhone(a.patient.phone)}</div>
                    </td>
                    <td>{a.service?.name ?? <span className="muted">{a.reason ?? "—"}</span>}</td>
                    <td>{a.provider?.name ?? "—"}</td>
                    <td><span className="small">{a.source === "STAFF" ? "Staff" : a.source === "SMS" ? "Text" : "AI"}</span></td>
                    <td><Badge value={a.status} /></td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {open && (
                        <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
                          {started ? (
                            <>
                              <button className="small green" disabled={busyId === a.id} onClick={() => setStatus(a.id, "SHOWED")}>Came</button>
                              <button className="small red" disabled={busyId === a.id} onClick={() => setStatus(a.id, "NO_SHOW")}>No-show</button>
                            </>
                          ) : (
                            <>
                              <button className="small" onClick={() => setResched(a)}>Reschedule</button>
                              <button className="small" disabled={busyId === a.id} onClick={() => confirm("Cancel this appointment?") && setStatus(a.id, "CANCELLED")}>Cancel</button>
                            </>
                          )}
                        </div>
                      )}
                      {(a.status === "SHOWED" || a.status === "NO_SHOW") && (
                        <button className="small link" onClick={() => setStatus(a.id, "BOOKED")}>Undo</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showNew && (
        <BookingModal tz={tz!} services={services} providers={providers} onClose={() => setShowNew(false)} onDone={() => { setShowNew(false); list.reload(); }} />
      )}
      {resched && (
        <BookingModal
          tz={tz!} services={services} providers={providers}
          reschedule={{ id: resched.id, serviceId: resched.service?.id, providerId: resched.provider?.id, patientName: patientName(resched.patient) }}
          onClose={() => setResched(null)} onDone={() => { setResched(null); list.reload(); }}
        />
      )}
    </>
  );
}

export default function Page() {
  return <Suspense><Appointments /></Suspense>;
}
