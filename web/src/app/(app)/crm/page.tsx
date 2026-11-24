"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, fmtPhone } from "@/lib/api";
import ContactDrawer, { relDue, STAGES } from "@/components/ContactDrawer";
import FilterBar, { useFilters } from "@/components/FilterBar";
import { Avatar, Badge, ErrorBox, Loading, Modal, useApi } from "@/components/ui";

const money = (n: number) => "$" + Number(n || 0).toLocaleString("en-US");
const SOURCES = ["AI call", "AI SMS", "AI outbound", "Website", "Google Ads", "Facebook", "Referral", "Walk-in", "Other"];
const TABS = ["Pipeline", "Contacts", "Tasks"] as const;

function Crm() {
  const router = useRouter();
  const params = useSearchParams();
  const tab = (TABS as readonly string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as (typeof TABS)[number]) : "Pipeline";
  const summary = useApi<any>("/api/crm/summary");
  const owners = useApi<{ id: string; name: string }[]>("/api/crm/owners");
  const [openId, setOpenId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const refreshAll = () => summary.reload();

  const s = summary.data;
  if (summary.error && /Growth and Pro/.test(String(summary.error))) {
    return (
      <>
        <div className="page-head"><div><h1>CRM</h1></div></div>
        <div className="card" style={{ maxWidth: 560 }}>
          <h2 style={{ marginTop: 0 }}>🔒 The CRM is part of Growth and Pro</h2>
          <p className="muted">Every caller who isn&apos;t ready to book becomes a lead with follow-up tasks, a pipeline and reminders — so price shoppers turn into patients. Growth also adds no-show rebooking and feedback calls.</p>
          <Link className="btn primary" href="/settings?tab=plan">See plans</Link>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="page-head">
        <div><h1>CRM</h1><div className="muted">Every inquiry the AI captures lands here. Move leads through the pipeline, log notes and never miss a follow-up.</div></div>
        <button className="primary" onClick={() => setShowNew(true)}>+ New contact</button>
      </div>
      {s && (
        <div className="grid k4" style={{ marginBottom: 14 }}>
          <div className="card stat"><div className="label">Open pipeline</div><div className="value">{money(s.openPipeline)}</div><div className="hint">{s.openCount} active leads</div></div>
          <div className="card stat"><div className="label">Won this month</div><div className="value" style={{ color: "var(--green)" }}>{money(s.wonThisMonth.value)}</div><div className="hint">{s.wonThisMonth.n} patients</div></div>
          <div className="card stat"><div className="label">Win rate</div><div className="value">{s.winRate}%</div><div className="hint">of closed leads</div></div>
          <div className="card stat"><div className="label">Follow-ups due today</div><div className="value" style={{ color: s.tasks.overdue ? "var(--red)" : undefined }}>{s.tasks.dueToday}</div><div className="hint">{s.tasks.overdue} overdue · {s.fromAi} leads from AI</div></div>
        </div>
      )}
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => router.replace(`/crm${t === "Pipeline" ? "" : `?tab=${t}`}`)}>
            {t}{t === "Tasks" && s?.tasks.overdue ? <> <span className="dot">{s.tasks.overdue}</span></> : null}
          </button>
        ))}
      </div>
      {tab === "Tasks" ? <Tasks owners={owners.data ?? []} onOpen={setOpenId} onChanged={refreshAll} /> : <Leads view={tab} owners={owners.data ?? []} onOpen={setOpenId} onChanged={refreshAll} />}
      {openId && <ContactDrawer id={openId} owners={owners.data ?? []} onClose={() => setOpenId(null)} onChanged={() => { refreshAll(); window.dispatchEvent(new Event("crm-changed")); }} />}
      {showNew && <NewContact owners={owners.data ?? []} onClose={() => setShowNew(false)} onDone={(id) => { setShowNew(false); refreshAll(); window.dispatchEvent(new Event("crm-changed")); setOpenId(id); }} />}
    </>
  );
}

function Leads({ view, owners, onOpen, onChanged }: { view: "Pipeline" | "Contacts"; owners: { id: string; name: string }[]; onOpen: (id: string) => void; onChanged: () => void }) {
  const f = useFilters();
  const { data, error, loading, reload } = useApi<any>(`/api/crm/leads${f.query ? `?${f.query}` : ""}`);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // reload when the drawer changes something
  useEffect(() => {
    const h = () => reload();
    window.addEventListener("crm-changed", h);
    return () => window.removeEventListener("crm-changed", h);
  }, [reload]);

  async function move(id: string, stage: string) {
    setErr(null);
    try {
      await api(`/api/crm/leads/${id}`, { method: "PATCH", body: { stage } });
      await reload();
      onChanged();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  const defs: any[] = [
    { key: "q", type: "search", label: "Search name, phone, interest" },
    { key: "source", type: "select", label: "All sources", options: (data?.sources ?? SOURCES).map((s: string) => [s, s]) },
    { key: "ownerId", type: "select", label: "All owners", options: [["none", "Unassigned"], ...owners.map((o) => [o.id, o.name])] },
    { key: "tag", type: "select", label: "All tags", options: (data?.tags ?? []).map((t: string) => [t, t]) },
  ];
  if (view === "Contacts") defs.push({ key: "stage", type: "select", label: "All stages", options: STAGES });
  const leads: any[] = data?.leads ?? [];

  return (
    <>
      <ErrorBox error={error || err} />
      <div className="card" style={{ padding: 0, marginBottom: view === "Pipeline" ? 12 : 0 }}>
        <FilterBar values={f.values} onChange={f.set} onClear={f.clear} active={f.active} shown={leads.length} defs={defs} />
        {view === "Contacts" && (loading && !data ? <Loading /> : !leads.length ? <div className="empty">No contacts match.</div> : (
          <table>
            <thead><tr><th>Contact</th><th>Interested in</th><th>Stage</th><th>Value</th><th>Source</th><th>Owner</th><th>Next follow-up</th></tr></thead>
            <tbody>
              {leads.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => onOpen(c.id)}>
                  <td><div className="row" style={{ gap: 8, flexWrap: "nowrap" }}><Avatar name={c.name ?? "?"} size={28} /><div><b>{c.name ?? "Unknown"}</b><div className="small muted">{fmtPhone(c.phone)}</div></div></div></td>
                  <td>{c.interest}<div>{c.tags.map((t: string) => <span key={t} className="tag">{t}</span>)}</div></td>
                  <td><Badge value={c.stage} /></td>
                  <td>{money(c.value)}</td>
                  <td className="small">{c.source}</td>
                  <td className="small">{c.owner?.name ?? "—"}</td>
                  <td className={c.nextTask && new Date(c.nextTask.dueAt) < new Date() ? "overdue small" : "small"}>{c.nextTask ? `${relDue(c.nextTask.dueAt)} · ${c.nextTask.title}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>
      {view === "Pipeline" && (loading && !data ? <Loading /> : (
        <>
          <div className="kanban">
            {STAGES.map(([k, label]) => {
              const cs = leads.filter((c) => c.stage === k);
              return (
                <div key={k} className={`kcol ${over === k ? "over" : ""}`}
                  onDragOver={(e) => { e.preventDefault(); setOver(k); }} onDragLeave={() => setOver(null)}
                  onDrop={(e) => { e.preventDefault(); setOver(null); if (dragId) move(dragId, k); setDragId(null); }}>
                  <div className="khead">{label} <small>{cs.length}</small></div>
                  <div className="ksum">{money(cs.reduce((t, c) => t + c.value, 0))}</div>
                  {cs.map((c) => {
                    const od = c.nextTask && new Date(c.nextTask.dueAt) < new Date();
                    return (
                      <div key={c.id} className="kcard" draggable onDragStart={() => setDragId(c.id)} onClick={() => onOpen(c.id)}>
                        <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
                          <Avatar name={c.name ?? "?"} size={26} />
                          <div style={{ minWidth: 0 }}><div className="nm">{c.name ?? fmtPhone(c.phone)}</div><div className="meta">{c.interest}</div></div>
                        </div>
                        <div>{c.tags.map((t: string) => <span key={t} className="tag">{t}</span>)}</div>
                        <div className="foot"><b>{money(c.value)}</b><span className={od ? "overdue" : "muted"}>{c.nextTask ? `${od ? "⚠ " : "⏰ "}${relDue(c.nextTask.dueAt).split(" ")[0]}` : c.source}</span></div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          <p className="small muted">Drag a card to another column, or click it to open the contact.</p>
        </>
      ))}
    </>
  );
}

function Tasks({ owners, onOpen, onChanged }: { owners: { id: string; name: string }[]; onOpen: (id: string) => void; onChanged: () => void }) {
  const f = useFilters({ status: "open" });
  const { data, error, loading, reload } = useApi<any[]>(`/api/crm/tasks?${f.query}`);
  useEffect(() => {
    const h = () => reload();
    window.addEventListener("crm-changed", h);
    return () => window.removeEventListener("crm-changed", h);
  }, [reload]);
  async function toggle(t: any) {
    await api(`/api/crm/tasks/${t.id}`, { method: "PATCH", body: { done: !t.doneAt } });
    await reload();
    onChanged();
  }
  return (
    <div className="card" style={{ padding: 0 }}>
      <ErrorBox error={error} />
      <FilterBar values={f.values} onChange={f.set} onClear={f.clear} active={f.active} shown={data?.length}
        defs={[
          { key: "status", type: "chips", options: [["open", "Open"], ["today", "Due today"], ["overdue", "Overdue"], ["done", "Done"], ["all", "All"]] },
          { key: "ownerId", type: "select", label: "All owners", options: [["none", "Unassigned"], ...owners.map((o) => [o.id, o.name] as [string, string])] },
          { key: "type", type: "select", label: "All types", options: [["CALL", "Call"], ["TEXT", "Text"], ["EMAIL", "Email"], ["OTHER", "Other"]] },
        ]} />
      {loading && !data ? <Loading /> : !data?.length ? <div className="empty">No tasks here. 🎉</div> : (
        <table>
          <thead><tr><th style={{ width: 40 }} /><th>Task</th><th>Contact</th><th>Type</th><th>Due</th><th>Owner</th></tr></thead>
          <tbody>
            {data.map((t) => (
              <tr key={t.id}>
                <td><input type="checkbox" style={{ width: 18, height: 18 }} checked={!!t.doneAt} onChange={() => toggle(t)} /></td>
                <td style={{ textDecoration: t.doneAt ? "line-through" : undefined, color: t.doneAt ? "var(--muted)" : undefined }}>{t.title}</td>
                <td><button className="link" onClick={() => onOpen(t.lead.id)}>{t.lead.name ?? fmtPhone(t.lead.phone)}</button></td>
                <td>{t.type.toLowerCase()}</td>
                <td className={t.overdue ? "overdue" : ""}>{t.overdue ? "⚠ " : ""}{relDue(t.dueAt)}</td>
                <td className="small">{t.owner?.name ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function NewContact({ owners, onClose, onDone }: { owners: { id: string; name: string }[]; onClose: () => void; onDone: (id: string) => void }) {
  const [f, setF] = useState({ name: "", phone: "", email: "", source: "Website", value: "500", interest: "", ownerId: "" });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  async function save() {
    setErr(null);
    try {
      const c = await api("/api/crm/leads", { body: { ...f, value: Math.max(0, Math.round(+f.value || 0)), ownerId: f.ownerId || null, email: f.email || undefined, interest: f.interest || undefined } });
      onDone(c.id);
    } catch (e: any) {
      setErr(e.message);
    }
  }
  return (
    <Modal title="New contact" onClose={onClose}>
      <ErrorBox error={err} />
      <div className="grid k2">
        <div className="field"><label>Name *</label><input value={f.name} onChange={set("name")} /></div>
        <div className="field"><label>Phone *</label><input value={f.phone} onChange={set("phone")} placeholder="(210) 555-0100" /></div>
        <div className="field"><label>Email</label><input value={f.email} onChange={set("email")} /></div>
        <div className="field"><label>Source</label><select value={f.source} onChange={set("source")}>{SOURCES.map((s) => <option key={s}>{s}</option>)}</select></div>
        <div className="field"><label>Deal value ($)</label><input type="number" value={f.value} onChange={set("value")} /></div>
        <div className="field"><label>Owner</label><select value={f.ownerId} onChange={set("ownerId")}><option value="">Unassigned</option>{owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
      </div>
      <div className="field"><label>Interested in</label><input value={f.interest} onChange={set("interest")} placeholder="e.g. Invisalign, implants, whitening" /></div>
      <p className="small muted">A &quot;First call&quot; task is created automatically.</p>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!f.name || !f.phone} onClick={save}>Create contact</button>
      </div>
    </Modal>
  );
}

export default function Page() {
  return <Suspense><Crm /></Suspense>;
}
