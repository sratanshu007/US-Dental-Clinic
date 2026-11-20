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

function cleanUrl(u: string): string {
  if (u && !u.startsWith("http://") && !u.startsWith("https://")) {
    u = `https://${u}`;
  }
  return u.replace(/\/$/, "");
}

function resolveApiUrl(): string {
  // If explicitly provided via EXPO_PUBLIC_API_URL and not a generic localhost
  const envUrl = process.env.EXPO_PUBLIC_API_URL;
  if (envUrl && !envUrl.includes("localhost") && !envUrl.includes("127.0.0.1")) {
    return cleanUrl(envUrl);
  }

  // If configured in app.json extra and not localhost
  const extraUrl = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl;
  if (extraUrl && !extraUrl.includes("localhost") && !extraUrl.includes("127.0.0.1")) {
    return cleanUrl(extraUrl);
  }

  // Auto-detect the host machine's LAN IP from Expo Metro connection
  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri) {
    const ip = hostUri.split(":")[0];
    if (ip && ip !== "localhost" && ip !== "127.0.0.1") {
      return `http://${ip}:4000`;
    }
  }

  return cleanUrl(envUrl || extraUrl || "http://localhost:4000");
}

export const API_URL: string = resolveApiUrl();

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
      if (!r.ok) {
        await clearSession();
        onSignedOut?.();
        return false;
      }
      const data = await r.json();
      await saveSession(data);
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
}

export async function api<T = any>(path: string, opts: ApiOptions = {}): Promise<T> {
  const method = opts.method ?? (opts.body ? "POST" : "GET");
  const auth = opts.auth ?? true;

  async function once(token: string | null): Promise<Response> {
    return fetch(`${API_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  }

  let r = await once(accessToken);
  if (r.status === 401 && auth && (await refresh())) {
    r = await once(accessToken);
  }
  if (!r.ok) {
    const text = await r.text();
    let msg = `HTTP ${r.status}`;
    try {
      const j = JSON.parse(text);
      msg = j.error ?? j.message ?? msg;
    } catch {}
    throw new Error(msg);
  }
  const ct = r.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return (await r.json()) as T;
  return (await r.text()) as unknown as T;
}

export function fmtTime(iso: string, tz?: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: tz ?? clinicTz,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function fmtDate(iso: string, tz?: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: tz ?? clinicTz,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function fmtDateTime(iso: string, tz?: string): string {
  return `${fmtDate(iso, tz)}, ${fmtTime(iso, tz)}`;
}

export function fmtPhone(e164: string): string {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export function money(centsOrDollars: number): string {
  const n = centsOrDollars > 100000 ? Math.round(centsOrDollars / 100) : centsOrDollars;
  return "$" + n.toLocaleString("en-US");
}

let clinicTz: string | undefined = undefined;
export function setClinicTz(tz?: string) {
  clinicTz = tz;
}

export function patientName(p?: { firstName?: string | null; lastName?: string | null } | null) {
  if (!p) return "—";
  return [p.firstName, p.lastName].filter(Boolean).join(" ") || "Unknown";
}

export function todayISO(tz?: string): string {
  try {
    return new Date().toLocaleDateString("en-CA", { timeZone: tz ?? clinicTz }); // YYYY-MM-DD
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function addDays(iso: string, n: number): string {
  try {
    const d = new Date(`${iso}T12:00:00`);
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

export function relDay(iso: string, tz?: string): string {
  try {
    const target = new Date(iso);
    const todayStr = todayISO(tz);
    const targetStr = new Date(target).toLocaleDateString("en-CA", { timeZone: tz ?? clinicTz });
    if (targetStr === todayStr) return "Today";
    const yestStr = addDays(todayStr, -1);
    if (targetStr === yestStr) return "Yesterday";
    const tomStr = addDays(todayStr, 1);
    if (targetStr === tomStr) return "Tomorrow";
    return fmtDate(iso, tz);
  } catch {
    return iso;
  }
}

export async function logout() {
  try {
    const rt = await SecureStore.getItemAsync(K.refresh);
    if (rt) {
      await fetch(`${API_URL}/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: rt }),
      });
    }
  } catch {
    /* ignore */
  }
  await clearSession();
  onSignedOut?.();
}
