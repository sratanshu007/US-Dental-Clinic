"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

/** Load data from the API with loading / error state and a reload function. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);

  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, error, loading, reload, setData };
}

export const STATUS_LABEL: Record<string, string> = {
  BOOKED: "Booked",
  CONFIRMED: "Confirmed",
  SHOWED: "Came",
  NO_SHOW: "No-show",
  CANCELLED: "Cancelled",
  RESCHEDULED: "Rescheduled",
  NEW: "New inquiry",
  CONTACTED: "Contacted",
  APPT: "Appointment booked",
  PLAN: "Treatment plan sent",
  WON: "Won",
  LOST: "Lost",
};

export function Badge({ value, label }: { value: string; label?: string }) {
  return <span className={`badge ${value}`}>{label ?? STATUS_LABEL[value] ?? value.replace(/_/g, " ").toLowerCase()}</span>;
}

export function Stars({ n }: { n: number | null }) {
  if (!n) return <span className="muted">—</span>;
  return <span className="stars" title={`${n}/5`}>{"★".repeat(n)}{"☆".repeat(5 - n)}</span>;
}

const AV_COLORS = ["#0f766e", "#2563eb", "#7c3aed", "#db2777", "#ea580c", "#0891b2", "#4d7c0f", "#b45309"];
export function Avatar({ name, size = 30 }: { name: string; size?: number }) {
  const color = AV_COLORS[[...name].reduce((s, c) => s + c.charCodeAt(0), 0) % AV_COLORS.length];
  const ini = name.split(" ").filter(Boolean).map((x) => x[0]).join("").slice(0, 2).toUpperCase() || "?";
  return <span className="av" style={{ background: color, width: size, height: size, fontSize: Math.round(size * 0.4) }}>{ini}</span>;
}

export function Loading() {
  return <div className="empty">Loading…</div>;
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? <div className="alert">{error}</div> : null;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="small" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}
