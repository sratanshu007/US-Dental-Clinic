"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { api, fmtDateTime, fmtPhone, patientName } from "@/lib/api";
import { Badge, ErrorBox, Loading, Stars, useApi } from "@/components/ui";

export default function PatientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: p, error, reload } = useApi<any>(`/api/patients/${id}`);
  const [form, setForm] = useState<any>(null);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (p) setForm({ firstName: p.firstName ?? "", lastName: p.lastName ?? "", email: p.email ?? "", notes: p.notes ?? "", smsConsent: p.smsConsent, callConsent: p.callConsent, smsOptOut: p.smsOptOut });
  }, [p]);

  async function save() {
    setErr(null);
    try {
      await api(`/api/patients/${id}`, { method: "PATCH", body: { ...form, email: form.email || null } });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      reload();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  if (!p || !form) return error ? <ErrorBox error={error} /> : <Loading />;

  return (
    <>
      <div className="page-head">
        <div>
          <Link href="/patients" className="small">← Patients</Link>
          <h1>{patientName(p)}</h1>
          <div className="muted">{fmtPhone(p.phone)} {p.isNew && <span className="badge">new patient</span>}</div>
        </div>
      </div>
      <div className="grid k2">
        <div className="card">
          <h2>Details</h2>
          <ErrorBox error={err} />
          {saved && <div className="ok">Saved</div>}
          <div className="grid k2">
            <div className="field"><label>First name</label><input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} /></div>
            <div className="field"><label>Last name</label><input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} /></div>
          </div>
          <div className="field"><label>Email</label><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div className="field"><label>Private notes (encrypted)</label><textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
          <div className="field">
            <label className="check"><input type="checkbox" checked={form.smsConsent} onChange={(e) => setForm({ ...form, smsConsent: e.target.checked })} /> Agreed to appointment texts</label>
            <label className="check"><input type="checkbox" checked={form.callConsent} onChange={(e) => setForm({ ...form, callConsent: e.target.checked })} /> Agreed to automated calls (no-show / feedback)</label>
            <label className="check"><input type="checkbox" checked={form.smsOptOut} onChange={(e) => setForm({ ...form, smsOptOut: e.target.checked })} /> Opted out of texts (replied STOP)</label>
          </div>
          <button className="primary" onClick={save}>Save</button>
        </div>

        <div className="card">
          <h2>Appointments</h2>
          {p.appointments.length === 0 ? <div className="empty">None</div> : (
            <table><tbody>
              {p.appointments.map((a: any) => (
                <tr key={a.id}>
                  <td>{fmtDateTime(a.startAt)}</td>
                  <td className="muted">{a.service?.name ?? a.reason ?? ""}</td>
                  <td><Badge value={a.status} /></td>
                </tr>
              ))}
            </tbody></table>
          )}
          <h2 style={{ marginTop: 18 }}>Feedback</h2>
          {p.feedback.length === 0 ? <div className="muted">No feedback yet</div> : p.feedback.map((f: any) => (
            <div key={f.id} style={{ marginBottom: 10 }}>
              <Stars n={f.rating} /> <span className="small muted">{fmtDateTime(f.createdAt)} · {f.channel.toLowerCase()}</span>
              {f.comment && <div>{f.comment}</div>}
            </div>
          ))}
          <h2 style={{ marginTop: 18 }}>Calls</h2>
          {p.calls.length === 0 ? <div className="muted">No calls</div> : (
            <table><tbody>
              {p.calls.map((c: any) => (
                <tr key={c.id}>
                  <td><Link href={`/calls/${c.id}`}>{fmtDateTime(c.startedAt)}</Link></td>
                  <td><Badge value={c.direction} label={c.direction === "INBOUND" ? "incoming" : "AI outbound"} /></td>
                  <td className="muted">{c.outcome?.toLowerCase() ?? ""}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </div>
      </div>
    </>
  );
}
