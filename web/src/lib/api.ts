"use client";

// API client for the clinic dashboard.
// Tokens live in sessionStorage (cleared when the tab closes) — never localStorage.

function getApiUrl(): string {
  const envUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!envUrl) {
    if (typeof window !== "undefined") {
      // In the browser, default to current origin (proxied by Next.js rewrites or same-origin)
      return "";
    }
    return "http://localhost:4000";
  }
  const trimmed = envUrl.trim().replace(/\/$/, "");
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

export const API_URL = getApiUrl();

export type Role = "SUPER_ADMIN" | "CLINIC_OWNER" | "CLINIC_STAFF";
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  clinicId: string | null;
  totpEnabled: boolean;
}

const K = { access: "dai.access", refresh: "dai.refresh", user: "dai.user", clinic: "dai.clinic", tz: "dai.tz" };

const ss = () => (typeof window === "undefined" ? null : window.sessionStorage);

export const session = {
  get user(): SessionUser | null {
    const raw = ss()?.getItem(K.user);
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  },
  get access() {
    return ss()?.getItem(K.access) ?? null;
  },
  get refresh() {
    return ss()?.getItem(K.refresh) ?? null;
  },
  /** Super admin: which clinic they are looking at. */
  get clinicId() {
    return ss()?.getItem(K.clinic) ?? null;
  },
  /** Clinic time zone — all times are shown in clinic time, not the viewer's. */
  get tz() {
    return ss()?.getItem(K.tz) ?? undefined;
  },
  setTz(tz: string) {
    ss()?.setItem(K.tz, tz);
  },
  setClinic(id: string | null) {
    if (id) ss()?.setItem(K.clinic, id);
    else ss()?.removeItem(K.clinic);
  },
  save(t: { accessToken: string; refreshToken: string; user: SessionUser }) {
    ss()?.setItem(K.access, t.accessToken);
    ss()?.setItem(K.refresh, t.refreshToken);
    ss()?.setItem(K.user, JSON.stringify(t.user));
  },
  clear() {
    Object.values(K).forEach((k) => ss()?.removeItem(k));
  },
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let refreshing: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  const rt = session.refresh;
  if (!rt) return false;
  refreshing ??= (async () => {
    try {
      const r = await fetch(`${API_URL}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!r.ok) return false;
      session.save(await r.json());
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}, retry = true): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (session.access) headers.Authorization = `Bearer ${session.access}`;
  if (session.user?.role === "SUPER_ADMIN" && session.clinicId) headers["X-Clinic-Id"] = session.clinicId;

  const r = await fetch(`${API_URL}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (r.status === 401 && retry && (await tryRefresh())) return api<T>(path, init, false);
  if (r.status === 401 && !path.startsWith("/auth/")) {
    session.clear();
    if (typeof window !== "undefined") window.location.href = "/login?expired=1";
  }
  const text = await r.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Response is not JSON (e.g. HTML 404, 502 Bad Gateway from cloud provider or wrong URL)
  }
  if (!r.ok) {
    const errorMsg = data?.error ?? (r.status === 404 ? `Endpoint not found (${r.status})` : `Request failed (${r.status})`);
    throw new ApiError(r.status, errorMsg);
  }
  return data as T;
}

export async function logout() {
  try {
    await api("/auth/logout", { body: { refreshToken: session.refresh } });
  } catch {
    /* ignore */
  }
  session.clear();
  window.location.href = "/login";
}

// ---------- formatting helpers ----------

export function fmtTime(iso: string, tz?: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz ?? session.tz });
}
export function fmtDate(iso: string, tz?: string) {
  return new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz ?? session.tz });
}
export function fmtDateTime(iso: string, tz?: string) {
  return `${fmtDate(iso, tz)}, ${fmtTime(iso, tz)}`;
}
export function fmtPhone(e164?: string | null) {
  if (!e164) return "";
  const d = e164.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e164;
}
export function patientName(p?: { firstName?: string | null; lastName?: string | null } | null) {
  if (!p) return "—";
  return [p.firstName, p.lastName].filter(Boolean).join(" ") || "Unknown";
}
export function todayISO(tz?: string) {
  return new Date().toLocaleDateString("en-CA", { timeZone: tz ?? session.tz }); // YYYY-MM-DD
}
export function addDays(iso: string, n: number) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
