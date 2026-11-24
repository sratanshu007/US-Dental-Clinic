// API client for the clinic app. Tokens are kept in the device's secure keychain (expo-secure-store).
import Constants from "expo-constants";
import * as SecureStoreNative from "expo-secure-store";
import { Platform } from "react-native";

// Device keychain on phones. (Web is only used for local previews: sessionStorage, cleared on tab close.)
const SecureStore = Platform.OS === "web"
  ? {
      getItemAsync: async (k: string) => globalThis.sessionStorage?.getItem(k) ?? null,
      setItemAsync: async (k: string, v: string) => globalThis.sessionStorage?.setItem(k, v),
      deleteItemAsync: async (k: string) => globalThis.sessionStorage?.removeItem(k),
    }
  : SecureStoreNative;

export const API_URL: string = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl || process.env.EXPO_PUBLIC_API_URL || "http://localhost:4000";

export interface User {
  id: string;
  email: string;
  name: string;
  role: "SUPER_ADMIN" | "CLINIC_OWNER" | "CLINIC_STAFF";
  clinicId: string | null;
  totpEnabled: boolean;
}

const K = { access: "dai_access", refresh: "dai_refresh", user: "dai_user" };

let accessToken: string | null = null;
let onSignedOut: (() => void) | null = null;

export function setSignedOutHandler(fn: () => void) {
  onSignedOut = fn;
}

export async function loadSession(): Promise<User | null> {
  accessToken = await SecureStore.getItemAsync(K.access);
  const u = await SecureStore.getItemAsync(K.user);
  return u ? (JSON.parse(u) as User) : null;
}

export async function saveSession(t: { accessToken: string; refreshToken: string; user: User }) {
  accessToken = t.accessToken;
  await SecureStore.setItemAsync(K.access, t.accessToken);
  await SecureStore.setItemAsync(K.refresh, t.refreshToken);
  await SecureStore.setItemAsync(K.user, JSON.stringify(t.user));
}

export async function clearSession() {
  accessToken = null;
  await Promise.all(Object.values(K).map((k) => SecureStore.deleteItemAsync(k)));
}

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const rt = await SecureStore.getItemAsync(K.refresh);
      if (!rt) return false;
      const r = await fetch(`${API_URL}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!r.ok) return false;
      await saveSession(await r.json());
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}, retry = true): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401 && retry && !path.startsWith("/auth/login") && (await refresh())) return api<T>(path, opts, false);
  if (r.status === 401 && !path.startsWith("/auth/")) {
    await clearSession();
    onSignedOut?.();
  }
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new ApiError(r.status, data?.error ?? `Request failed (${r.status})`);
  return data as T;
}

export async function logout() {
  try {
    const rt = await SecureStore.getItemAsync(K.refresh);
    await api("/auth/logout", { body: { refreshToken: rt } });
  } catch {
    /* ignore */
  }
  await clearSession();
  onSignedOut?.();
}

// ---------- formatting ----------
let clinicTz: string | undefined;
export const setClinicTz = (tz: string) => (clinicTz = tz);

export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: clinicTz });
export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: clinicTz });
export const fmtPhone = (e164?: string | null) => {
  const d = (e164 ?? "").replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e164 ?? "";
};
export const patientName = (p?: { firstName?: string | null; lastName?: string | null } | null) =>
  p ? [p.firstName, p.lastName].filter(Boolean).join(" ") || "Unknown" : "—";
export const todayISO = () => new Date().toLocaleDateString("en-CA", { timeZone: clinicTz });
export const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
export const money = (n: number) => "$" + Number(n || 0).toLocaleString("en-US");
/** "Today" / "Tomorrow" / "Yesterday" / "Mon, Nov 24" in clinic time. */
export const relDay = (iso: string) => {
  const ymd = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: clinicTz });
  const diff = Math.round((Date.parse(ymd(new Date(iso))) - Date.parse(ymd(new Date()))) / 86400000);
  return diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff === -1 ? "Yesterday" : fmtDate(iso);
};
