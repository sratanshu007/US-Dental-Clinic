"use client";

import Link from "next/link";
import { useEffect } from "react";
import { api, fmtDateTime } from "@/lib/api";
import FilterBar, { useFilters } from "@/components/FilterBar";
import { ErrorBox, Loading, useApi } from "@/components/ui";

const TYPES: [string, string][] = [
  ["NEW_BOOKING", "Bookings"], ["NEW_LEAD", "New inquiries"], ["TASKS", "Follow-ups"], ["DAILY_REPORT", "Daily reports"],
  ["FEEDBACK", "Feedback"], ["NO_SHOW", "No-shows"], ["CANCELLED", "Cancellations"], ["TRANSFER", "Transfers"], ["SMS", "Texts"],
];
const linkFor = (l: string) => (l.startsWith("/appointments/") ? "/appointments" : l.startsWith("/reports") ? l : l.split("?")[0]);

export default function Notifications() {
  const f = useFilters();
  const { data, error, loading, reload } = useApi<any[]>(`/api/notifications${f.query ? `?${f.query}` : ""}`);
  useEffect(() => {
    if (!f.values.unread && data?.some((n) => !n.readAt)) api("/api/notifications/read-all", { method: "POST" }).catch(() => {});
  }, [data, f.values.unread]);

  return (
    <>
      <div className="page-head">
        <div><h1>Notifications</h1><div className="muted">The same alerts the mobile app sends. No patient details in alerts (HIPAA).</div></div>
        <button onClick={() => api("/api/notifications/read-all", { method: "POST" }).then(reload)}>Mark all read</button>
      </div>
      <ErrorBox error={error} />
      <div className="card" style={{ padding: 0 }}>
        <FilterBar
          values={f.values} onChange={f.set} onClear={f.clear} active={f.active} shown={data?.length}
          defs={[
            { key: "type", type: "select", label: "All types", options: TYPES },
            { key: "unread", type: "chips", options: [["", "All"], ["1", "Unread only"]] },
          ]}
        />
        {loading && !data ? <Loading /> : !data?.length ? <div className="empty">No notifications.</div> : (
          <table><tbody>
            {data.map((n) => (
              <tr key={n.id} style={{ background: n.readAt ? undefined : "#f4faf9" }}>
                <td style={{ width: 170 }} className="muted small">{fmtDateTime(n.createdAt)}</td>
                <td><b>{n.title}</b><div className="muted">{n.body}</div></td>
                <td className="small muted">{TYPES.find((t) => t[0] === n.type)?.[1] ?? ""}</td>
                <td style={{ textAlign: "right" }}>{n.link && <Link href={linkFor(n.link)}>Open</Link>}</td>
              </tr>
            ))}
          </tbody></table>
        )}
      </div>
    </>
  );
}
