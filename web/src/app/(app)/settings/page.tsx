"use client";

import { useEffect, useState } from "react";
import { api, fmtDateTime, fmtPhone, logout, session } from "@/lib/api";
import FilterBar, { useFilters } from "@/components/FilterBar";
import { ErrorBox, Loading, useApi } from "@/components/ui";

const DAYS: [string, string][] = [["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]];
const TABS = ["Clinic & AI", "Hours", "Services & dentists", "Follow-ups & texts", "Plan & billing", "Practice software", "Team", "Security", "Audit log"] as const;

export default function Settings() {
  const { data, error, reload } = useApi<any>("/api/settings");
  const [tab, setTab] = useState<(typeof TABS)[number]>("Clinic & AI");
  // Deep links: /settings?tab=plan (upgrade prompts, billing banners)
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t === "plan" || new URLSearchParams(window.location.search).get("billing")) setTab("Plan & billing");
  }, []);
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
            <div className="field"><label>Plivo AI phone number</label><input value={c.aiPhoneNumber ?? ""} onChange={set("aiPhoneNumber")} placeholder="+1 (210) 555-0100" /></div>
            <div className="field"><label>Staff transfer number (live transfer & emergencies)</label><input value={c.transferNumber ?? ""} onChange={set("transferNumber")} placeholder="(210) 555-0199" /></div>
            <div className="field"><label>Appointment slot length (minutes)</label><input type="number" value={c.slotMinutes} onChange={set("slotMinutes")} /></div>
          </div>
          <div className="field"><label className="check"><input type="checkbox" checked={c.aiEnabled} onChange={set("aiEnabled")} /> AI receptionist answers calls</label></div>
          <div className="field"><label>Greeting (first thing the AI says)</label><input value={c.aiGreeting ?? ""} onChange={set("aiGreeting")} placeholder={`Thank you for calling ${c.name}. How can I help you today?`} />
            <div className="small muted">The AI always adds that the call is being recorded for monitoring purposes and that it&apos;s the clinic&apos;s AI assistant (required in several states).</div></div>
          <div className="field">
            <label>What the AI should know (insurance, prices, parking, policies)</label>
            <textarea rows={6} value={c.aiExtraInstructions ?? ""} onChange={set("aiExtraInstructions")} placeholder="We accept Delta Dental, Cigna, Aetna. New patient special $99. Free parking behind the building. We do not treat children under 3." />
            <div className="small muted">Don&apos;t put patient information here.</div>
          </div>
          <button className="primary" onClick={() => saveClinic(["name", "aiPhoneNumber", "timezone", "address", "website", "transferNumber", "slotMinutes", "aiEnabled", "aiGreeting", "aiExtraInstructions"])}>Save</button>
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
      {tab === "Plan & billing" && isOwner && <Billing />}
      {tab === "Practice software" && isOwner && <PracticeSoftware providers={data.providers} />}

      {tab === "Follow-ups & texts" && isOwner && (
        <div className="card">
          <h3>Text messages</h3>
          <div className="field"><label className="check"><input type="checkbox" checked={c.smsEnabled} onChange={set("smsEnabled")} /> Send texts (booking confirmations, reminders)</label></div>
          <div className="field"><label className="check"><input type="checkbox" checked={c.smsOnlyBooked ?? true} onChange={set("smsOnlyBooked")} /> Text patients only once an appointment is booked (confirmation + reminder; no &quot;we missed you&quot; or feedback texts)</label></div>
          <div className="field" style={{ maxWidth: 520 }}>
            <label>What the text contains</label>
            <select value={c.smsStyle ?? "LINK"} onChange={set("smsStyle")}>
              <option value="LINK">Secure link only (recommended for HIPAA) — details shown after the patient confirms it&apos;s them</option>
              <option value="FULL">Day and time in the text</option>
            </select>
          </div>
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
          <button className="primary" onClick={() => saveClinic(["smsEnabled", "smsOnlyBooked", "smsStyle", "reminderHoursBefore", "noShowFollowUp", "noShowDelayMinutes", "autoNoShowAfterMinutes", "feedbackEnabled", "feedbackChannel", "feedbackDelayMinutes", "callingHoursStart", "callingHoursEnd", "dailyReportTime", "taskDigestTime", "retentionDays"])}>Save</button>
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
        <div className="field"><label>Temporary password (12+ characters)</label><input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
        <div className="field"><label>Role</label><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="CLINIC_STAFF">Front desk / staff</option><option value="CLINIC_OWNER">Owner (full access)</option></select></div>
      </div>
      <button className="primary" disabled={!f.name || !f.email || f.password.length < 12} onClick={add}>Add member</button>
    </div>
  );
}

function Security() {
  const [qr, setQr] = useState<{ qrDataUrl: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [mfaPw, setMfaPw] = useState("");
  const [offCode, setOffCode] = useState("");
  const [pw, setPw] = useState({ currentPassword: "", newPassword: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(!!session.user?.totpEnabled);
  const run = async (fn: () => Promise<void>) => { setErr(null); setMsg(null); try { await fn(); } catch (e: any) { setErr(e.message); } };
  const markUser = (totpEnabled: boolean) => {
    const u = session.user;
    if (u && session.access && session.refresh) session.save({ accessToken: session.access, refreshToken: session.refresh, user: { ...u, totpEnabled } });
    setEnabled(totpEnabled);
  };
  return (
    <div className="grid k2">
      <div className="card">
        <h2>Two-step login (2FA)</h2>
        {msg && <div className="ok">{msg}</div>}
        <ErrorBox error={err} />
        <p className="muted">Required for super admins and strongly recommended for everyone. Use Google Authenticator, Microsoft Authenticator or Authy.</p>
        {enabled && !qr && (
          <>
            <p><span className="badge SHOWED">On</span></p>
            <div className="field"><label>To turn it off: your password</label><input type="password" value={mfaPw} onChange={(e) => setMfaPw(e.target.value)} autoComplete="current-password" /></div>
            <div className="row">
              <input placeholder="6-digit code" value={offCode} onChange={(e) => setOffCode(e.target.value)} style={{ width: 160 }} inputMode="numeric" />
              <button onClick={() => run(async () => { await api("/auth/mfa/disable", { body: { password: mfaPw, code: offCode } }); markUser(false); setMsg("2FA is off. You were signed out on all devices."); setTimeout(() => logout(), 1500); })}>Turn off 2FA</button>
            </div>
          </>
        )}
        {!enabled && !qr && (
          <>
            <div className="field"><label>Confirm your password</label><input type="password" value={mfaPw} onChange={(e) => setMfaPw(e.target.value)} autoComplete="current-password" /></div>
            <button className="primary" disabled={!mfaPw} onClick={() => run(async () => { setQr(await api("/auth/mfa/setup", { body: { password: mfaPw } })); setMfaPw(""); })}>Turn on 2FA</button>
          </>
        )}
        {qr && (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr.qrDataUrl} alt="2FA QR code" width={180} height={180} />
            <p className="small muted">Can&apos;t scan? Enter this key: <code>{qr.secret}</code></p>
            <div className="row">
              <input placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} style={{ width: 160 }} inputMode="numeric" />
              <button className="primary" onClick={() => run(async () => { await api("/auth/mfa/enable", { body: { code } }); setQr(null); markUser(true); setMsg("2FA is on. You'll need a code next time you sign in."); })}>Confirm</button>
            </div>
          </>
        )}
      </div>
      <div className="card">
        <h2>Change password</h2>
        <div className="field"><label>Current password</label><input type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></div>
        <div className="field"><label>New password (12+ characters; a short phrase works well)</label><input type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></div>
        <button className="primary" disabled={pw.newPassword.length < 12} onClick={() => run(async () => {
          const r = await api<any>("/auth/change-password", { body: pw });
          if (r.accessToken) session.save(r);
          setPw({ currentPassword: "", newPassword: "" });
          setMsg("Password changed. All other devices were signed out.");
        })}>Change password</button>
        <h3 style={{ marginTop: 24 }}>Lost a phone or laptop?</h3>
        <button onClick={() => run(async () => { await api("/auth/logout-all", { method: "POST" }); session.clear(); window.location.href = "/login"; })}>Sign out on all devices</button>
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

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0 })}`;

function Billing() {
  const { data, error } = useApi<any>("/api/integrations/billing");
  const [err, setErr] = useState<string | null>(null);
  const [plan, setPlan] = useState<string>("GROWTH");
  useEffect(() => { if (data) setPlan(data.current.plan); }, [data]);
  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;
  const u = data.usage;
  const go = async (path: string, body?: unknown) => {
    setErr(null);
    try {
      const r = await api<{ url: string }>(path, { method: "POST", body });
      window.location.href = r.url;
    } catch (e: any) { setErr(e.message); }
  };
  const status: Record<string, string> = {
    TRIAL: "Trial / founding clinic", MANUAL: "Invoiced by Deific Digital", ACTIVE: "Active (card)", PAST_DUE: "Payment failed — update your card", CANCELED: "Canceled — AI is off",
  };
  return (
    <div className="grid k2">
      <div className="card">
        <h2>This month</h2>
        <div className="muted">{data.current.name} plan · {status[data.current.billingStatus] ?? data.current.billingStatus}</div>
        <div style={{ fontSize: 30, fontWeight: 700, margin: "12px 0 4px" }}>{u.minutes.toLocaleString()} <span className="muted" style={{ fontSize: 16 }}>of {u.includedMinutes.toLocaleString()} minutes</span></div>
        <div style={{ height: 10, background: "#e5e7eb", borderRadius: 6, overflow: "hidden" }}>
          <div style={{ width: `${Math.min(100, u.percentUsed)}%`, height: "100%", background: u.percentUsed >= 100 ? "#dc2626" : u.percentUsed >= 80 ? "#f59e0b" : "#2563eb" }} />
        </div>
        {u.overageMinutes > 0 && <p className="small">Extra: {u.overageMinutes} min = {money(u.overageCents)} on your next invoice.</p>}
        <p className="small muted">Minutes count every connected call, rounded up per call. You get an alert at 80%.</p>
        {data.history.length > 0 && (
          <table><thead><tr><th>Month</th><th>Minutes</th><th>Extra</th></tr></thead><tbody>
            {data.history.map((h: any) => <tr key={h.id}><td>{h.period}</td><td>{h.minutes}</td><td>{h.overageCents ? money(h.overageCents) : "—"}</td></tr>)}
          </tbody></table>
        )}
      </div>
      <div className="card">
        <h2>Plan</h2>
        <ErrorBox error={err} />
        {(["STARTER", "GROWTH", "PRO"] as const).map((k) => {
          const p = data.plans[k];
          return (
            <label key={k} className="check" style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 0", borderBottom: "1px solid #eee" }}>
              <input type="radio" name="plan" checked={plan === k} onChange={() => setPlan(k)} />
              <span><b>{p.name}</b> — {money(p.priceCents)}/month · {p.minutes.toLocaleString()} min · {p.maxProviders ?? "unlimited"} dentists
                <div className="small muted">{[p.allHours ? "24/7" : "after-hours + overflow", p.noShowCalls && "no-show rebooking", p.feedback && "feedback calls", p.crm && "CRM", p.pmsSync && "Open Dental sync", p.maxExtraNumbers && `${p.maxExtraNumbers} extra numbers`].filter(Boolean).join(" · ")}</div>
              </span>
            </label>
          );
        })}
        <div className="row" style={{ marginTop: 12 }}>
          {!data.current.hasCard
            ? <button className="primary" onClick={() => go("/api/integrations/billing/checkout", { plan, setup: "STANDARD" })}>Pay by card</button>
            : <button className="primary" onClick={() => go("/api/integrations/billing/portal")}>Manage card & invoices</button>}
        </div>
        <p className="small muted">Payments are handled by Stripe. Plan changes on an active subscription: use “Manage card & invoices” or email hello@deificdigital.com.</p>
      </div>
    </div>
  );
}

function PracticeSoftware({ providers }: { providers: any[] }) {
  const { data, error, reload } = useApi<any>("/api/integrations/pms");
  const [form, setForm] = useState<any>(null);
  const [lists, setLists] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (data) setForm({ type: data.type, customerKey: "", clinicNum: data.clinicNum ?? "", operatoryNum: data.operatoryNum ?? "", providerMap: { ...data.providerMap } });
  }, [data]);
  if (!data || !form) return error ? <ErrorBox error={error} /> : <Loading />;
  const run = async (fn: () => Promise<void>) => { setErr(null); setMsg(null); try { await fn(); } catch (e: any) { setErr(e.message); } };
  const save = () => run(async () => {
    await api("/api/integrations/pms", { method: "PUT", body: {
      type: form.type, ...(form.customerKey ? { customerKey: form.customerKey } : {}),
      clinicNum: form.clinicNum ? Number(form.clinicNum) : null, operatoryNum: form.operatoryNum ? Number(form.operatoryNum) : null,
      providerMap: Object.fromEntries(Object.entries(form.providerMap).filter(([, v]) => v).map(([k, v]) => [k, Number(v)])),
    } });
    setMsg("Saved"); reload();
  });
  const test = () => run(async () => {
    const r = await api<any>("/api/integrations/pms/test", { method: "POST" });
    if (!r.ok) throw new Error(r.error);
    setLists(r); setMsg(`Connected: ${r.providers.length} providers, ${r.operatories.length} operatories found.`);
  });
  const sync = () => run(async () => {
    const r = await api<any>("/api/integrations/pms/sync", { method: "POST" });
    if (!r.ok) throw new Error(r.error);
    setMsg(`Synced: ${r.busyAppointments} Open Dental appointments are blocking times.`); reload();
  });
  if (!data.allowed) return <div className="card">Open Dental sync is included in the Growth and Pro plans.</div>;
  return (
    <div className="card">
      <h2>Open Dental</h2>
      <p className="muted" style={{ marginTop: 0 }}>Every few minutes the AI reads your Open Dental schedule (times only) so it never double-books, and every AI booking, reschedule and cancellation is written into Open Dental.</p>
      {msg && <div className="ok">{msg}</div>}
      <ErrorBox error={err ?? data.error} />
      <div className="field" style={{ maxWidth: 320 }}><label>Practice software</label>
        <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
          <option value="NONE">None (use the built-in calendar only)</option>
          <option value="OPEN_DENTAL">Open Dental</option>
        </select>
      </div>
      {form.type === "OPEN_DENTAL" && (
        <>
          <div className="field"><label>Customer API key {data.connected && <span className="small muted">(saved — leave empty to keep it)</span>}</label>
            <input type="password" value={form.customerKey} onChange={(e) => setForm({ ...form, customerKey: e.target.value })} placeholder="From Open Dental: Setup > Advanced Setup > API > Add Key" /></div>
          <div className="row">
            <button onClick={save}>Save key</button>
            <button onClick={test} disabled={!data.connected}>Test connection</button>
            <button onClick={sync} disabled={!data.connected}>Sync now</button>
          </div>
          <div className="grid k2" style={{ marginTop: 14 }}>
            <div className="field"><label>Operatory for AI bookings</label>
              {lists ? (
                <select value={form.operatoryNum} onChange={(e) => setForm({ ...form, operatoryNum: e.target.value })}>
                  <option value="">Choose…</option>
                  {lists.operatories.map((o: any) => <option key={o.opNum} value={o.opNum}>{o.name}</option>)}
                </select>
              ) : <input value={form.operatoryNum} onChange={(e) => setForm({ ...form, operatoryNum: e.target.value })} placeholder="Test connection to pick from a list" />}
            </div>
            <div className="field"><label>Open Dental clinic number (multi-location offices only)</label><input value={form.clinicNum} onChange={(e) => setForm({ ...form, clinicNum: e.target.value })} /></div>
          </div>
          <h3>Match your dentists</h3>
          <table><tbody>
            {providers.map((p) => (
              <tr key={p.id}><td style={{ width: 220 }}>{p.name}</td><td>
                {lists ? (
                  <select value={form.providerMap[p.id] ?? ""} onChange={(e) => setForm({ ...form, providerMap: { ...form.providerMap, [p.id]: e.target.value } })}>
                    <option value="">Not linked</option>
                    {lists.providers.map((x: any) => <option key={x.provNum} value={x.provNum}>{x.name}</option>)}
                  </select>
                ) : <input value={form.providerMap[p.id] ?? ""} onChange={(e) => setForm({ ...form, providerMap: { ...form.providerMap, [p.id]: e.target.value } })} placeholder="ProvNum" style={{ width: 120 }} />}
              </td></tr>
            ))}
          </tbody></table>
          <button className="primary" style={{ marginTop: 12 }} onClick={save}>Save</button>
          <p className="small muted">Last sync: {data.lastSyncAt ? fmtDateTime(data.lastSyncAt) : "never"}. The Open Dental eConnector must be running at the office.</p>
        </>
      )}
      {form.type === "NONE" && data.type !== "NONE" && <button className="primary" onClick={save}>Turn off sync</button>}
    </div>
  );
}
