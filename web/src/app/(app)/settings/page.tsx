"use client";

import { useEffect, useState } from "react";
import { api, fmtDateTime, fmtPhone, session } from "@/lib/api";
import FilterBar, { useFilters } from "@/components/FilterBar";
import { ErrorBox, Loading, useApi } from "@/components/ui";

const DAYS: [string, string][] = [["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]];
const TABS = ["Clinic & AI", "Hours", "Services & dentists", "Follow-ups & texts", "Team", "Security", "Audit log"] as const;

export default function Settings() {
  const { data, error, reload } = useApi<any>("/api/settings");
  const [tab, setTab] = useState<(typeof TABS)[number]>("Clinic & AI");
  const [c, setC] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const isOwner = session.user?.role !== "CLINIC_STAFF";

  useEffect(() => {
    if (data) setC(structuredClone(data.clinic));
  }, [data]);

  async function saveClinic(fields: string[]) {
    setErr(null);
    setMsg(null);
    try {
      const body: any = {};
      for (const f of fields) body[f] = c[f] === "" ? null : c[f];
      await api("/api/settings", { method: "PATCH", body });
      setMsg("Saved");
      reload();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  if (!data || !c) return error ? <ErrorBox error={error} /> : <Loading />;
  const set = (k: string) => (e: any) => setC({ ...c, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.type === "number" ? Number(e.target.value) : e.target.value });
  const tabs = isOwner ? TABS : (["Security"] as const);

  return (
    <>
      <div className="page-head"><div><h1>Settings</h1><div className="muted">AI number: {fmtPhone(c.aiPhoneNumber)}</div></div></div>
      <div className="tabs">
        {tabs.map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => { setTab(t); setMsg(null); setErr(null); }}>{t}</button>)}
      </div>
      {msg && <div className="ok">{msg}</div>}
      <ErrorBox error={err} />

      {tab === "Clinic & AI" && isOwner && (
        <div className="card">
          <div className="grid k2">
            <div className="field"><label>Clinic name</label><input value={c.name} onChange={set("name")} /></div>
            <div className="field"><label>Time zone</label>
              <select value={c.timezone} onChange={set("timezone")}>
                {["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"].map((z) => <option key={z}>{z}</option>)}
              </select>
            </div>
            <div className="field"><label>Address</label><input value={c.address ?? ""} onChange={set("address")} /></div>
            <div className="field"><label>Website</label><input value={c.website ?? ""} onChange={set("website")} /></div>
            <div className="field"><label>Staff transfer number (live transfer & emergencies)</label><input value={c.transferNumber ?? ""} onChange={set("transferNumber")} placeholder="(210) 555-0199" /></div>
            <div className="field"><label>Appointment slot length (minutes)</label><input type="number" value={c.slotMinutes} onChange={set("slotMinutes")} /></div>
          </div>
          <div className="field"><label className="check"><input type="checkbox" checked={c.aiEnabled} onChange={set("aiEnabled")} /> AI receptionist answers calls</label></div>
          <div className="field"><label>Greeting (first thing the AI says)</label><input value={c.aiGreeting ?? ""} onChange={set("aiGreeting")} placeholder={`Thank you for calling ${c.name}, this is the virtual assistant. How can I help you today?`} /></div>
          <div className="field">
            <label>What the AI should know (insurance, prices, parking, policies)</label>
            <textarea rows={6} value={c.aiExtraInstructions ?? ""} onChange={set("aiExtraInstructions")} placeholder="We accept Delta Dental, Cigna, Aetna. New patient special $99. Free parking behind the building. We do not treat children under 3." />
            <div className="small muted">Don&apos;t put patient information here.</div>
          </div>
          <button className="primary" onClick={() => saveClinic(["name", "timezone", "address", "website", "transferNumber", "slotMinutes", "aiEnabled", "aiGreeting", "aiExtraInstructions"])}>Save</button>
        </div>
      )}

      {tab === "Hours" && isOwner && (
        <div className="card">
          <p className="muted" style={{ marginTop: 0 }}>The AI only books inside these hours.</p>
          <table><tbody>
            {DAYS.map(([k, label]) => {
              const w = c.businessHours[k]?.[0];
              const update = (v: [string, string][] ) => setC({ ...c, businessHours: { ...c.businessHours, [k]: v } });
              return (
                <tr key={k}>
                  <td style={{ width: 140 }}><b>{label}</b></td>
                  <td style={{ width: 120 }}><label className="check"><input type="checkbox" checked={!!w} onChange={(e) => update(e.target.checked ? [["09:00", "17:00"]] : [])} /> Open</label></td>
                  <td>{w && (
                    <div className="row">
                      <input type="time" value={w[0]} onChange={(e) => update([[e.target.value, w[1]]])} style={{ width: 140 }} />
                      to
                      <input type="time" value={w[1]} onChange={(e) => update([[w[0], e.target.value]])} style={{ width: 140 }} />
                    </div>
                  )}</td>
                </tr>
              );
            })}
          </tbody></table>
          <button className="primary" style={{ marginTop: 12 }} onClick={() => saveClinic(["businessHours"])}>Save hours</button>
        </div>
      )}

      {tab === "Services & dentists" && isOwner && <ServicesAndProviders data={data} reload={reload} />}

      {tab === "Follow-ups & texts" && isOwner && (
        <div className="card">
          <h3>Text messages</h3>
          <div className="field"><label className="check"><input type="checkbox" checked={c.smsEnabled} onChange={set("smsEnabled")} /> Send texts (booking confirmations, reminders)</label></div>
          <div className="field" style={{ maxWidth: 260 }}><label>Reminder text, hours before visit</label><input type="number" value={c.reminderHoursBefore} onChange={set("reminderHoursBefore")} /></div>
          <h3 style={{ marginTop: 18 }}>No-shows</h3>
          <div className="field"><label className="check"><input type="checkbox" checked={c.noShowFollowUp} onChange={set("noShowFollowUp")} /> AI calls no-show patients to rebook</label></div>
          <div className="grid k2">
            <div className="field"><label>Call after (minutes)</label><input type="number" value={c.noShowDelayMinutes} onChange={set("noShowDelayMinutes")} /></div>
            <div className="field"><label>Auto-mark no-show if not marked after (minutes, empty = off)</label><input type="number" value={c.autoNoShowAfterMinutes ?? ""} onChange={(e) => setC({ ...c, autoNoShowAfterMinutes: e.target.value ? Number(e.target.value) : null })} /></div>
          </div>
          <h3 style={{ marginTop: 18 }}>Feedback</h3>
          <div className="field"><label className="check"><input type="checkbox" checked={c.feedbackEnabled} onChange={set("feedbackEnabled")} /> Ask patients for feedback after their visit</label></div>
          <div className="grid k2">
            <div className="field"><label>How</label><select value={c.feedbackChannel} onChange={set("feedbackChannel")}><option value="CALL">AI phone call</option><option value="SMS">Text message</option></select></div>
            <div className="field"><label>After (minutes)</label><input type="number" value={c.feedbackDelayMinutes} onChange={set("feedbackDelayMinutes")} /></div>
          </div>
          <h3 style={{ marginTop: 18 }}>Calling hours & report</h3>
          <div className="grid k3">
            <div className="field"><label>AI may call patients from</label><input type="time" value={c.callingHoursStart} onChange={set("callingHoursStart")} /></div>
            <div className="field"><label>until</label><input type="time" value={c.callingHoursEnd} onChange={set("callingHoursEnd")} /></div>
            <div className="field"><label>Daily report time</label><input type="time" value={c.dailyReportTime} onChange={set("dailyReportTime")} /></div>
          </div>
          <div className="field" style={{ maxWidth: 260 }}><label>Morning CRM follow-up reminder</label><input type="time" value={c.taskDigestTime} onChange={set("taskDigestTime")} /></div>
          <div className="field" style={{ maxWidth: 260 }}><label>Delete call transcripts after (days)</label><input type="number" value={c.retentionDays} onChange={set("retentionDays")} /></div>
          <button className="primary" onClick={() => saveClinic(["smsEnabled", "reminderHoursBefore", "noShowFollowUp", "noShowDelayMinutes", "autoNoShowAfterMinutes", "feedbackEnabled", "feedbackChannel", "feedbackDelayMinutes", "callingHoursStart", "callingHoursEnd", "dailyReportTime", "taskDigestTime", "retentionDays"])}>Save</button>
        </div>
      )}

      {tab === "Team" && isOwner && <Team />}
      {tab === "Security" && <Security />}
      {tab === "Audit log" && isOwner && <Audit />}
    </>
  );
}

function ServicesAndProviders({ data, reload }: { data: any; reload: () => void }) {
  const [svc, setSvc] = useState({ name: "", durationMin: 30 });
  const [prov, setProv] = useState({ name: "", title: "Dentist" });
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try { await fn(); reload(); } catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="grid k2">
      <div className="card">
        <h2>Services</h2>
        <ErrorBox error={err} />
        <table><tbody>
          {data.services.map((s: any) => (
            <tr key={s.id}>
              <td style={{ opacity: s.active ? 1 : 0.5 }}>{s.name}</td>
              <td className="muted">{s.durationMin} min</td>
              <td style={{ textAlign: "right" }}><button className="small" onClick={() => run(() => api(`/api/services/${s.id}`, { method: "PATCH", body: { active: !s.active } }))}>{s.active ? "Hide" : "Show"}</button></td>
            </tr>
          ))}
        </tbody></table>
        <div className="row" style={{ marginTop: 12 }}>
          <input className="grow" placeholder="New service" value={svc.name} onChange={(e) => setSvc({ ...svc, name: e.target.value })} style={{ flex: 1 }} />
          <input type="number" value={svc.durationMin} onChange={(e) => setSvc({ ...svc, durationMin: Number(e.target.value) })} style={{ width: 80 }} />
          <button disabled={!svc.name} onClick={() => run(async () => { await api("/api/services", { body: svc }); setSvc({ name: "", durationMin: 30 }); })}>Add</button>
        </div>
      </div>
      <div className="card">
        <h2>Dentists & hygienists</h2>
        <p className="small muted" style={{ marginTop: 0 }}>Each one can have one patient at a time. No providers = one appointment at a time for the clinic.</p>
        <table><tbody>
          {data.providers.map((p: any) => (
            <tr key={p.id}>
              <td style={{ opacity: p.active ? 1 : 0.5 }}>{p.name}</td>
              <td className="muted">{p.title}</td>
              <td style={{ textAlign: "right" }}><button className="small" onClick={() => run(() => api(`/api/providers/${p.id}`, { method: "PATCH", body: { active: !p.active } }))}>{p.active ? "Deactivate" : "Activate"}</button></td>
            </tr>
          ))}
        </tbody></table>
        <div className="row" style={{ marginTop: 12 }}>
          <input placeholder="Dr. Name" value={prov.name} onChange={(e) => setProv({ ...prov, name: e.target.value })} style={{ flex: 1 }} />
          <input value={prov.title} onChange={(e) => setProv({ ...prov, title: e.target.value })} style={{ width: 120 }} />
          <button disabled={!prov.name} onClick={() => run(async () => { await api("/api/providers", { body: prov }); setProv({ name: "", title: "Dentist" }); })}>Add</button>
        </div>
      </div>
    </div>
  );
}

function Team() {
  const { data, reload } = useApi<any[]>("/api/team");
  const [f, setF] = useState({ name: "", email: "", password: "", role: "CLINIC_STAFF" });
  const [err, setErr] = useState<string | null>(null);
  async function add() {
    setErr(null);
    try { await api("/api/team", { body: f }); setF({ name: "", email: "", password: "", role: "CLINIC_STAFF" }); reload(); } catch (e: any) { setErr(e.message); }
  }
  return (
    <div className="card">
      <ErrorBox error={err} />
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>2FA</th><th>Last login</th><th></th></tr></thead>
        <tbody>
          {data?.map((u) => (
            <tr key={u.id} style={{ opacity: u.active ? 1 : 0.5 }}>
              <td>{u.name}</td><td>{u.email}</td><td>{u.role === "CLINIC_OWNER" ? "Owner" : "Staff"}</td>
              <td>{u.totpEnabled ? "On" : <span className="badge NO_SHOW">off</span>}</td>
              <td className="muted">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : "never"}</td>
              <td style={{ textAlign: "right" }}>
                {u.id !== session.user?.id && <button className="small" onClick={() => api(`/api/team/${u.id}`, { method: "PATCH", body: { active: !u.active } }).then(reload)}>{u.active ? "Disable" : "Enable"}</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 style={{ marginTop: 18 }}>Add a team member</h3>
      <div className="grid k2">
        <div className="field"><label>Name</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div className="field"><label>Email</label><input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
        <div className="field"><label>Temporary password (10+ characters)</label><input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
        <div className="field"><label>Role</label><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="CLINIC_STAFF">Front desk / staff</option><option value="CLINIC_OWNER">Owner (full access)</option></select></div>
      </div>
      <button className="primary" disabled={!f.name || !f.email || f.password.length < 10} onClick={add}>Add member</button>
    </div>
  );
}

function Security() {
  const [qr, setQr] = useState<{ qrDataUrl: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [pw, setPw] = useState({ currentPassword: "", newPassword: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const enabled = session.user?.totpEnabled;
  const run = async (fn: () => Promise<void>) => { setErr(null); setMsg(null); try { await fn(); } catch (e: any) { setErr(e.message); } };
  return (
    <div className="grid k2">
      <div className="card">
        <h2>Two-step login (2FA)</h2>
        {msg && <div className="ok">{msg}</div>}
        <ErrorBox error={err} />
        <p className="muted">Required for HIPAA best practice. Use Google Authenticator, Microsoft Authenticator or Authy.</p>
        {enabled && !qr && <p><span className="badge SHOWED">On</span></p>}
        {!qr ? (
          <button className="primary" onClick={() => run(async () => setQr(await api("/auth/mfa/setup", { method: "POST" })))}>{enabled ? "Reset 2FA" : "Turn on 2FA"}</button>
        ) : (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr.qrDataUrl} alt="2FA QR code" width={180} height={180} />
            <p className="small muted">Can&apos;t scan? Enter this key: <code>{qr.secret}</code></p>
            <div className="row">
              <input placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} style={{ width: 160 }} />
              <button className="primary" onClick={() => run(async () => { await api("/auth/mfa/enable", { body: { code } }); setQr(null); setMsg("2FA is on. You'll need a code next time you sign in."); })}>Confirm</button>
            </div>
          </>
        )}
      </div>
      <div className="card">
        <h2>Change password</h2>
        <div className="field"><label>Current password</label><input type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></div>
        <div className="field"><label>New password (10+ characters)</label><input type="password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></div>
        <button className="primary" disabled={pw.newPassword.length < 10} onClick={() => run(async () => { await api("/auth/change-password", { body: pw }); setPw({ currentPassword: "", newPassword: "" }); setMsg("Password changed. Other devices were signed out."); })}>Change password</button>
      </div>
    </div>
  );
}

function Audit() {
  const f = useFilters();
  const all = useApi<any[]>("/api/audit-logs");
  const { data } = useApi<any[]>(`/api/audit-logs${f.query ? `?${f.query}` : ""}`);
  if (!data) return <Loading />;
  const actors = [...new Set((all.data ?? []).map((l) => l.actor as string))].sort();
  return (
    <div className="card" style={{ padding: 0 }}>
      <FilterBar values={f.values} onChange={f.set} onClear={f.clear} active={f.active} shown={data.length}
        defs={[{ key: "q", type: "search", label: "Search action, e.g. view patient" }, { key: "actor", type: "select", label: "Everyone", options: actors.map((a) => [a, a]) }]} />
      <table>
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>IP</th></tr></thead>
        <tbody>
          {data.map((l) => (
            <tr key={l.id}>
              <td className="muted small" style={{ whiteSpace: "nowrap" }}>{fmtDateTime(l.createdAt)}</td>
              <td>{l.actor}</td>
              <td>{l.action.replace(/_/g, " ").toLowerCase()}</td>
              <td className="small muted">{l.entity ? `${l.entity} ${l.entityId?.slice(-6)}` : ""}</td>
              <td className="small muted">{l.ip ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
