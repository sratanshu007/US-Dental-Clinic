"use client";

import { useState } from "react";
import { api, fmtDateTime, fmtPhone, fmtTime, session } from "@/lib/api";
import { Avatar, ErrorBox, Loading, useApi } from "./ui";

export const STAGES: [string, string][] = [
  ["NEW", "New inquiry"], ["CONTACTED", "Contacted"], ["APPT", "Appointment booked"], ["PLAN", "Treatment plan sent"], ["WON", "Won"], ["LOST", "Lost"],
];
const ICON: Record<string, string> = { CALL: "📞", SMS: "💬", EMAIL: "✉️", NOTE: "📝", APPT: "📅", STAGE: "➡️", TASK: "✅", CREATED: "➕" };
const DUE_OPTIONS: [string, number][] = [["In 1 hour", 1 / 24], ["Tomorrow", 1], ["In 3 days", 3], ["Next week", 7]];

/** "Today 4:00 PM" / "Tomorrow 9:00 AM" in clinic time. */
export function relDue(iso: string) {
  const ymd = (x: Date) => x.toLocaleDateString("en-CA", { timeZone: session.tz });
  const diff = Math.round((Date.parse(ymd(new Date(iso))) - Date.parse(ymd(new Date()))) / 86400000);
  const t = fmtTime(iso);
  return diff === 0 ? `Today ${t}` : diff === 1 ? `Tomorrow ${t}` : diff === -1 ? `Yesterday ${t}` : fmtDateTime(iso);
}

export default function ContactDrawer({ id, owners, onClose, onChanged }: { id: string; owners: { id: string; name: string }[]; onClose: () => void; onChanged: () => void }) {
  const { data: c, reload, error } = useApi<any>(`/api/crm/leads/${id}`);
  const [note, setNote] = useState("");
  const [task, setTask] = useState({ title: "", due: "1" });
  const [tagText, setTagText] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      await reload();
      onChanged();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const patch = (body: any) => run(() => api(`/api/crm/leads/${id}`, { method: "PATCH", body }));

  return (
    <>
      <div className="drawer-back" onClick={onClose} />
      <div className="drawer">
        {!c ? <div className="db">{error ? <ErrorBox error={error} /> : <Loading />}</div> : (
          <>
            <div className="dh">
              <div className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
                <div className="row" style={{ flexWrap: "nowrap" }}>
                  <Avatar name={c.name ?? "?"} size={44} />
                  <div><h2 style={{ margin: 0 }}>{c.name ?? "Unknown"}</h2><div className="small muted">{fmtPhone(c.phone)}{c.email ? ` · ${c.email}` : ""}</div></div>
                </div>
                <button className="small" onClick={onClose}>✕</button>
              </div>
              <div className="row" style={{ marginTop: 12 }}>
                <a className="btn primary small" href={`tel:${c.phone}`} onClick={() => api(`/api/crm/leads/${id}/activities`, { body: { type: "CALL", text: "Called the patient." } }).then(() => { reload(); onChanged(); })}>📞 Call {fmtPhone(c.phone)}</a>
                <button className="small" onClick={() => run(() => api(`/api/crm/leads/${id}/activities`, { body: { type: "SMS", text: "Sent a text message." } }))}>💬 Log text</button>
                <a className="btn small" href={`/appointments?new=1`}>📅 Book appointment</a>
              </div>
            </div>
            <div className="db">
              <ErrorBox error={err} />
              <div className="grid k2">
                <div className="field"><label>Stage</label>
                  <select value={c.stage} onChange={(e) => patch({ stage: e.target.value })}>{STAGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
                <div className="field"><label>Deal value ($)</label>
                  <input type="number" defaultValue={c.value} onBlur={(e) => +e.target.value !== c.value && patch({ value: Math.max(0, Math.round(+e.target.value)) })} /></div>
                <div className="field"><label>Owner</label>
                  <select value={c.ownerId ?? ""} onChange={(e) => patch({ ownerId: e.target.value || null })}>
                    <option value="">Unassigned</option>{owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
                <div className="field"><label>Source</label><input value={c.source} disabled /></div>
              </div>
              <div className="field"><label>Interested in</label>
                <input defaultValue={c.interest ?? ""} onBlur={(e) => e.target.value !== (c.interest ?? "") && patch({ interest: e.target.value || null })} /></div>
              <div className="field"><label>Tags</label>
                <div className="row" style={{ gap: 4 }}>
                  {c.tags.map((t: string) => <span key={t} className="tag">{t} <button className="link small" onClick={() => patch({ tags: c.tags.filter((x: string) => x !== t) })}>×</button></span>)}
                  <input placeholder="Add tag + Enter" value={tagText} style={{ width: 150, padding: "4px 8px" }} onChange={(e) => setTagText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && tagText.trim()) { patch({ tags: [...new Set([...c.tags, tagText.trim()])] }); setTagText(""); } }} />
                </div>
              </div>

              <h3>Follow-up tasks</h3>
              {c.tasks.length === 0 && <div className="small muted">No tasks.</div>}
              {c.tasks.map((t: any) => (
                <div key={t.id} className="row" style={{ marginBottom: 6, flexWrap: "nowrap" }}>
                  <input type="checkbox" style={{ width: 18, height: 18 }} checked={!!t.doneAt} onChange={() => run(() => api(`/api/crm/tasks/${t.id}`, { method: "PATCH", body: { done: !t.doneAt } }))} />
                  <span style={{ flex: 1, textDecoration: t.doneAt ? "line-through" : undefined, color: t.doneAt ? "var(--muted)" : undefined }}>{t.title}</span>
                  <span className={`small ${!t.doneAt && new Date(t.dueAt) < new Date() ? "overdue" : "muted"}`}>{relDue(t.dueAt)}</span>
                </div>
              ))}
              <div className="row" style={{ marginTop: 8, flexWrap: "nowrap" }}>
                <input placeholder="New task, e.g. Call back about financing" value={task.title} onChange={(e) => setTask({ ...task, title: e.target.value })} />
                <select style={{ width: 130 }} value={task.due} onChange={(e) => setTask({ ...task, due: e.target.value })}>{DUE_OPTIONS.map(([l, d]) => <option key={l} value={d}>{l}</option>)}</select>
                <button className="small" disabled={!task.title.trim()} onClick={() => run(async () => {
                  await api(`/api/crm/leads/${id}/tasks`, { body: { title: task.title.trim(), type: "CALL", dueAt: new Date(Date.now() + +task.due * 86400000).toISOString() } });
                  setTask({ title: "", due: "1" });
                })}>Add</button>
              </div>

              <h3>Add a note</h3>
              <div className="row" style={{ flexWrap: "nowrap" }}>
                <input placeholder="What happened? e.g. Sent price list" value={note} onChange={(e) => setNote(e.target.value)} />
                <button className="small primary" disabled={!note.trim()} onClick={() => run(async () => { await api(`/api/crm/leads/${id}/activities`, { body: { type: "NOTE", text: note.trim() } }); setNote(""); })}>Save</button>
              </div>

              <h3>Activity</h3>
              <div className="timeline">
                {c.activities.map((a: any) => (
                  <div key={a.id} className="tl"><div>{ICON[a.type] ?? "•"} {a.text}</div><div className="t">{fmtDateTime(a.createdAt)} · {a.actor}</div></div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
