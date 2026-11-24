"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { fmtDateTime, patientName } from "@/lib/api";
import { useState } from "react";
import { Badge, ErrorBox, Loading, useApi } from "@/components/ui";
import FilterBar from "@/components/FilterBar";

const money = (n: number) => "$" + Number(n || 0).toLocaleString("en-US");

export default function Dashboard() {
  const router = useRouter();
  const { data, error, loading } = useApi<any>("/api/dashboard");
  const [prov, setProv] = useState("");
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const { today, last7, clinic, openLeads, crm, plan } = data;
  const crmOn = plan?.features?.crm !== false;
  const dentists = [...new Map(data.upcoming.filter((a: any) => a.provider).map((a: any) => [a.provider.id, a.provider.name])).entries()] as [string, string][];
  const upcoming = data.upcoming.filter((a: any) => !prov || a.provider?.id === prov);
  const max = Math.max(1, ...last7.map((d: any) => d.scheduled));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Good day 👋</h1>
          <div className="muted">Here is what your AI receptionist did today at {clinic.name}.</div>
        </div>
        <Link className="btn primary" href="/appointments?new=1">+ New appointment</Link>
      </div>

      <div className="grid k4" style={{ marginBottom: 14 }}>
        <div className="card stat"><div className="label">Booked by AI today</div><div className="value">{today.newBookingsByAi}</div><div className="hint">{today.callsHandled} calls handled</div></div>
        <div className="card stat"><div className="label">Patients came</div><div className="value" style={{ color: "var(--green)" }}>{today.showed}</div><div className="hint">of {today.scheduled} scheduled today</div></div>
        <div className="card stat"><div className="label">No-shows</div><div className="value" style={{ color: "var(--red)" }}>{today.noShow}</div><div className="hint">{today.unmarked} not marked yet</div></div>
        {crmOn ? (
          <Link href="/crm" className="card stat" style={{ color: "inherit", textDecoration: "none" }}><div className="label">CRM pipeline</div><div className="value">{money(crm.openPipeline)}</div><div className="hint">{openLeads} new inquiries · {crm.tasksDue} follow-ups due{crm.tasksOverdue ? ` (${crm.tasksOverdue} overdue)` : ""}</div></Link>
        ) : (
          <Link href="/settings?tab=plan" className="card stat" style={{ color: "inherit", textDecoration: "none" }}><div className="label">Plan</div><div className="value" style={{ fontSize: 22 }}>{plan.name}</div><div className="hint">Upgrade to Growth for no-show rebooking, feedback calls and the CRM →</div></Link>
        )}
      </div>

      <div className="grid k2">
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2>Upcoming appointments</h2>
            <Link href="/appointments" className="small">View all</Link>
          </div>
          {dentists.length > 1 && (
            <div style={{ margin: "0 -16px 8px" }}>
              <FilterBar values={{ prov }} onChange={(_, v) => setProv(v)} onClear={() => setProv("")} active={!!prov}
                defs={[{ key: "prov", type: "chips", options: [["", "All dentists"], ...dentists] }]} />
            </div>
          )}
          {upcoming.length === 0 ? (
            <div className="empty">No upcoming appointments</div>
          ) : (
            <table>
              <tbody>
                {upcoming.map((a: any) => (
                  <tr key={a.id} className="clickable" onClick={() => router.push(`/patients/${a.patient.id}`)}>
                    <td style={{ whiteSpace: "nowrap" }}>{fmtDateTime(a.startAt, clinic.timezone)}</td>
                    <td>{patientName(a.patient)}{a.patient.isNew && <span className="badge" style={{ marginLeft: 6 }}>new</span>}</td>
                    <td className="muted">{a.service?.name ?? a.reason ?? ""}</td>
                    <td><Badge value={a.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <h2>Last 7 days — came vs no-show</h2>
          <div className="bar">
            {last7.map((d: any) => (
              <div key={d.date}>
                <div className="col" style={{ height: `${(d.scheduled / max) * 100}%`, minHeight: 4 }} title={`${d.showed} came, ${d.noShow} no-show, ${d.scheduled} scheduled`}>
                  <div className="seg-show" style={{ height: `${d.scheduled ? (d.showed / d.scheduled) * 100 : 0}%` }} />
                  <div className="seg-no" style={{ height: `${d.scheduled ? (d.noShow / d.scheduled) * 100 : 0}%` }} />
                </div>
                <div className="lbl">{new Date(`${d.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" })}</div>
              </div>
            ))}
          </div>
          <div className="row small muted" style={{ marginTop: 10 }}>
            <span><span className="badge SHOWED">came</span></span>
            <span><span className="badge NO_SHOW">no-show</span></span>
            <span>Gray = not marked / upcoming</span>
          </div>
          <div className="grid k3" style={{ marginTop: 14 }}>
            <div><div className="muted small">AI bookings (7d)</div><b>{last7.reduce((s: number, d: any) => s + d.newBookingsByAi, 0)}</b></div>
            <div><div className="muted small">Calls (7d)</div><b>{last7.reduce((s: number, d: any) => s + d.callsHandled, 0)}</b></div>
            <div><div className="muted small">Avg rating today</div><b>{today.avgRating ?? "—"}</b></div>
          </div>
        </div>
      </div>
    </>
  );
}
