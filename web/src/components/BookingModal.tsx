"use client";

import { useEffect, useState } from "react";
import { api, fmtTime, todayISO } from "@/lib/api";
import { ErrorBox, Modal } from "./ui";

interface Props {
  tz: string;
  services: { id: string; name: string; durationMin: number; active: boolean }[];
  providers: { id: string; name: string; active: boolean }[];
  /** When set, the modal reschedules this appointment instead of creating a new one. */
  reschedule?: { id: string; serviceId?: string | null; providerId?: string | null; patientName: string };
  onClose: () => void;
  onDone: () => void;
}

export default function BookingModal({ tz, services, providers, reschedule, onClose, onDone }: Props) {
  const [date, setDate] = useState(todayISO(tz));
  const [serviceId, setServiceId] = useState(reschedule?.serviceId ?? "");
  const [providerId, setProviderId] = useState(reschedule?.providerId ?? "");
  const [slots, setSlots] = useState<any[] | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [form, setForm] = useState({ phone: "", firstName: "", lastName: "", reason: "", smsConsent: true, callConsent: true });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSlots(null);
    setSlot(null);
    const q = new URLSearchParams({ date });
    if (serviceId) q.set("serviceId", serviceId);
    if (providerId) q.set("providerId", providerId);
    api<any[]>(`/api/availability?${q}`).then(setSlots).catch((e) => setError(e.message));
  }, [date, serviceId, providerId]);

  async function save() {
    if (!slot) return setError("Pick a time");
    setBusy(true);
    setError(null);
    try {
      if (reschedule) {
        await api(`/api/appointments/${reschedule.id}/reschedule`, { body: { startAt: slot } });
      } else {
        await api("/api/appointments", {
          body: {
            ...form,
            startAt: slot,
            serviceId: serviceId || undefined,
            providerId: providerId || undefined,
            lastName: form.lastName || undefined,
            reason: form.reason || undefined,
          },
        });
      }
      onDone();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={reschedule ? `Reschedule — ${reschedule.patientName}` : "New appointment"} onClose={onClose}>
      <ErrorBox error={error} />
      <div className="grid k3">
        <div className="field">
          <label>Date</label>
          <input type="date" value={date} min={todayISO(tz)} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="field">
          <label>Service</label>
          <select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
            <option value="">Standard visit</option>
            {services.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.durationMin}m)</option>)}
          </select>
        </div>
        <div className="field">
          <label>Dentist</label>
          <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="">Any</option>
            {providers.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>
      <label>Available times</label>
      <div className="slots" style={{ marginBottom: 14 }}>
        {slots === null ? <span className="muted">Loading…</span> : slots.length === 0 ? <span className="muted">No open times this day</span> :
          slots.map((s) => (
            <button key={s.startAt} type="button" className={`slot ${slot === s.startAt ? "sel" : ""}`} onClick={() => setSlot(s.startAt)} title={s.providerName ?? ""}>
              {fmtTime(s.startAt, tz)}
            </button>
          ))}
      </div>
      {!reschedule && (
        <>
          <div className="grid k3">
            <div className="field"><label>Phone *</label><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="(210) 555-0142" /></div>
            <div className="field"><label>First name *</label><input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} /></div>
            <div className="field"><label>Last name</label><input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} /></div>
          </div>
          <div className="field"><label>Reason (short)</label><input value={form.reason} maxLength={200} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="cleaning, tooth pain…" /></div>
          <div className="row" style={{ marginBottom: 14 }}>
            <label className="check"><input type="checkbox" checked={form.smsConsent} onChange={(e) => setForm({ ...form, smsConsent: e.target.checked })} /> Patient agreed to text reminders</label>
            <label className="check"><input type="checkbox" checked={form.callConsent} onChange={(e) => setForm({ ...form, callConsent: e.target.checked })} /> Agreed to automated calls</label>
          </div>
        </>
      )}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || !slot || (!reschedule && (!form.phone || !form.firstName))} onClick={save}>
          {busy ? "Saving…" : reschedule ? "Move appointment" : "Book appointment"}
        </button>
      </div>
    </Modal>
  );
}
