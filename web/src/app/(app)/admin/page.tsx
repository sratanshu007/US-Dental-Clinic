"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, fmtDate, fmtPhone, session } from "@/lib/api";
import { ErrorBox, Loading, Modal, useApi } from "@/components/ui";

export default function Admin() {
  const router = useRouter();
  const { data, error, loading, reload } = useApi<any[]>("/admin/clinics");
  const [show, setShow] = useState(false);

  if (session.user && session.user.role !== "SUPER_ADMIN") {
    router.replace("/dashboard");
    return null;
  }

  const open = (id: string) => {
    session.setClinic(id);
    router.push("/dashboard");
  };

  const totals = (data ?? []).reduce((t, c) => ({ calls: t.calls + c.thisMonth.calls, minutes: t.minutes + c.thisMonth.minutes, bookings: t.bookings + c.thisMonth.aiBookings }), { calls: 0, minutes: 0, bookings: 0 });

  return (
    <>
      <div className="page-head">
        <div><h1>All clinics</h1><div className="muted">Deific Digital super admin. Open a clinic to see its dashboard.</div></div>
        <button className="primary" onClick={() => setShow(true)}>+ Add clinic</button>
      </div>
      <div className="grid k4" style={{ marginBottom: 14 }}>
        <div className="card stat"><div className="label">Clinics</div><div className="value">{data?.length ?? 0}</div></div>
        <div className="card stat"><div className="label">Calls this month</div><div className="value">{totals.calls}</div></div>
        <div className="card stat"><div className="label">Minutes this month</div><div className="value">{totals.minutes}</div><div className="hint">for Plivo / AI cost tracking</div></div>
        <div className="card stat"><div className="label">AI bookings this month</div><div className="value">{totals.bookings}</div></div>
      </div>
      <ErrorBox error={error} />
      <div className="card" style={{ padding: 0 }}>
        {loading && !data ? <Loading /> : !data?.length ? <div className="empty">No clinics yet.</div> : (
          <table>
            <thead><tr><th>Clinic</th><th>AI number</th><th>Status</th><th>Plan</th><th>Billing</th><th>Calls</th><th>Minutes</th><th>AI bookings</th><th>Since</th><th></th></tr></thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.id}>
                  <td><b>{c.name}</b><div className="small muted">{c.timezone}</div></td>
                  <td>{fmtPhone(c.aiPhoneNumber)}</td>
                  <td>{!c.active ? <span className="badge NO_SHOW">inactive</span> : c.aiEnabled ? <span className="badge SHOWED">AI on</span> : <span className="badge CANCELLED">AI paused</span>}</td>
                  <td>
                    <select value={c.plan} onChange={(e) => api(`/admin/clinics/${c.id}`, { method: "PATCH", body: { plan: e.target.value } }).then(reload)}>
                      <option value="STARTER">Starter</option><option value="GROWTH">Growth</option><option value="PRO">Pro</option>
                    </select>
                  </td>
                  <td>
                    <select value={c.billingStatus} onChange={(e) => api(`/admin/clinics/${c.id}`, { method: "PATCH", body: { billingStatus: e.target.value } }).then(reload)}>
                      {["TRIAL", "MANUAL", "ACTIVE", "PAST_DUE", "CANCELED"].map((b) => <option key={b} value={b}>{b.replace("_", " ").toLowerCase()}</option>)}
                    </select>
                  </td>
                  <td>{c.thisMonth.calls}</td>
                  <td>{c.thisMonth.minutes}</td>
                  <td>{c.thisMonth.aiBookings}</td>
                  <td className="muted">{fmtDate(c.createdAt)}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button className="small" onClick={() => api(`/admin/clinics/${c.id}`, { method: "PATCH", body: { active: !c.active } }).then(reload)}>{c.active ? "Deactivate" : "Activate"}</button>{" "}
                    <button className="small primary" onClick={() => open(c.id)}>Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {show && <NewClinic onClose={() => setShow(false)} onDone={() => { setShow(false); reload(); }} />}
    </>
  );
}

function NewClinic({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: "", aiPhoneNumber: "", timezone: "America/Chicago", address: "", transferNumber: "", ownerName: "", ownerEmail: "", ownerPassword: "", plan: "GROWTH", billingStatus: "TRIAL" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api("/admin/clinics", {
        body: {
          name: f.name, aiPhoneNumber: f.aiPhoneNumber, timezone: f.timezone, address: f.address || undefined, transferNumber: f.transferNumber || undefined,
          owner: { name: f.ownerName, email: f.ownerEmail, password: f.ownerPassword },
          plan: f.plan, billingStatus: f.billingStatus,
        },
      });
      onDone();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Add clinic" onClose={onClose}>
      <ErrorBox error={err} />
      <p className="small muted" style={{ marginTop: 0 }}>Before going live: buy the Plivo number, point it to the voice agent, and sign a BAA with the clinic.</p>
      <div className="field"><label>Clinic name</label><input value={f.name} onChange={set("name")} /></div>
      <div className="grid k2">
        <div className="field"><label>Plivo AI number</label><input value={f.aiPhoneNumber} onChange={set("aiPhoneNumber")} placeholder="+1 210 555 0100" /></div>
        <div className="field"><label>Time zone</label>
          <select value={f.timezone} onChange={set("timezone")}>
            {["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"].map((z) => <option key={z}>{z}</option>)}
          </select>
        </div>
        <div className="field"><label>Address</label><input value={f.address} onChange={set("address")} /></div>
        <div className="field"><label>Staff transfer number</label><input value={f.transferNumber} onChange={set("transferNumber")} /></div>
      </div>
      <h3>Clinic owner login</h3>
      <div className="grid k2">
        <div className="field"><label>Name</label><input value={f.ownerName} onChange={set("ownerName")} /></div>
        <div className="field"><label>Email</label><input value={f.ownerEmail} onChange={set("ownerEmail")} /></div>
      </div>
      <div className="field"><label>Temporary password (12+ characters)</label><input type="password" value={f.ownerPassword} onChange={set("ownerPassword")} /></div>
      <div className="grid k2">
        <div className="field"><label>Plan</label>
          <select value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })}>
            <option value="STARTER">Starter — $299/mo, 1,000 min</option>
            <option value="GROWTH">Growth — $499/mo, 2,000 min</option>
            <option value="PRO">Pro — $799/mo, 4,000 min</option>
          </select>
        </div>
        <div className="field"><label>Billing</label>
          <select value={f.billingStatus} onChange={(e) => setF({ ...f, billingStatus: e.target.value })}>
            <option value="TRIAL">Trial / founding (free setup)</option>
            <option value="MANUAL">Manual invoice</option>
            <option value="ACTIVE">Active (paid)</option>
          </select>
        </div>
      </div>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || !f.name || !f.aiPhoneNumber || !f.ownerEmail || f.ownerPassword.length < 12} onClick={save}>{busy ? "Creating…" : "Create clinic"}</button>
      </div>
    </Modal>
  );
}
