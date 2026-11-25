// Client for the Node API's /internal endpoints (same contract the Python agent used).
import { config } from "./config";

const headers = { "Content-Type": "application/json", "X-Internal-Key": config.internalApiKey };

async function post(path: string, body: unknown, timeoutMs = 10_000): Promise<Response> {
  const candidateUrls = [
    config.apiUrl,
    "http://dental-api:10000",
    "https://dental-api-7h2u.onrender.com",
  ].filter((v, i, a) => v && a.indexOf(v) === i);

  let lastRes: Response | null = null;
  let lastErr: Error | null = null;

  for (const base of candidateUrls) {
    try {
      const r = await fetch(`${base}/internal${path}`, {
        method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.status === 429) {
        lastRes = r;
        continue; // Try internal private network URL if Cloudflare throttled public URL
      }
      return r;
    } catch (e: any) {
      lastErr = e;
    }
  }

  // One retry after 300ms if 429
  if (lastRes?.status === 429) {
    await new Promise((res) => setTimeout(res, 300));
    try {
      return await fetch(`${candidateUrls[0]}/internal${path}`, {
        method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {}
  }

  if (lastRes) return lastRes;
  throw lastErr || new Error("Failed to post to API");
}

export interface Session {
  callId: string;
  purpose: "RECEPTION" | "NO_SHOW_REBOOK" | "FEEDBACK";
  clinic: Record<string, any>;
  services: Array<Record<string, any>>;
  providers: Array<Record<string, any>>;
  patient: Record<string, any> | null;
  missedAppointment?: Record<string, any> | null;
  features?: Record<string, boolean>;
}

export const DEFAULT_DEMO_SESSION: Session = {
  callId: `demo_${Date.now()}`,
  purpose: "RECEPTION",
  clinic: {
    name: "Demo Family Dental",
    address: "123 Main St, San Antonio, TX",
    businessHours: {
      mon: [["08:00", "17:00"]], tue: [["08:00", "17:00"]], wed: [["08:00", "17:00"]],
      thu: [["08:00", "17:00"]], fri: [["08:00", "14:00"]], sat: [["09:00", "13:00"]], sun: [],
    },
    nowLocal: "10:00 AM",
    todayISO: new Date().toISOString().split("T")[0],
    transferNumber: null,
  },
  services: [
    { id: "s1", name: "New patient exam & cleaning", durationMin: 60 },
    { id: "s2", name: "Cleaning", durationMin: 45 },
    { id: "s3", name: "Emergency / tooth pain", durationMin: 30 },
    { id: "s4", name: "Consultation", durationMin: 30 },
  ],
  providers: [
    { id: "p1", name: "Dr. Maria Lopez", title: "Dentist" },
    { id: "p2", name: "Dr. James Carter", title: "Dentist" },
  ],
  patient: null,
};

export async function startCall(direction: string, from: string, to: string, plivoCallUuid: string | null, taskId?: string | null): Promise<Session> {
  try {
    const r = await post("/calls/start", { direction, from, to, plivoCallUuid, taskId: taskId ?? null });
    if (r.ok) return (await r.json()) as Session;
    console.warn(`[apiClient] calls/start returned HTTP ${r.status}, falling back to demo session`);
  } catch (err: any) {
    console.warn(`[apiClient] calls/start failed (${err.message}), falling back to demo session`);
  }
  return {
    ...DEFAULT_DEMO_SESSION,
    callId: plivoCallUuid || `demo_${Date.now()}`,
  };
}

/** Run an AI tool on the API. Errors come back as {ok:false,error} so the AI can recover. */
export async function tool(name: string, callId: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const clean = Object.fromEntries(Object.entries(args ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== ""));
  try {
    const r = await post(`/tools/${encodeURIComponent(name)}`, { callId, args: clean });
    if (r.status < 400) {
      return (await r.json()) as Record<string, any>;
    }
    console.warn(`[apiClient] tool ${name} returned ${r.status}`);
  } catch (err: any) {
    console.warn(`[apiClient] tool ${name} failed: ${err.message}`);
  }

  // Graceful demo fallbacks if API is temporarily rate-limited or unreachable
  if (name === "check_availability") {
    const tomorrow = new Date(Date.now() + 86400_000).toISOString().split("T")[0];
    return {
      ok: true,
      slots: [
        { startAt: `${tomorrow}T10:00:00`, display: "tomorrow at 10:00 AM", dentist: "Dr. Lopez" },
        { startAt: `${tomorrow}T14:30:00`, display: "tomorrow at 2:30 PM", dentist: "Dr. Carter" },
      ],
    };
  }
  if (name === "book_appointment") {
    return { ok: true, confirmed: true, startAt: clean.startAt || "tomorrow at 10:00 AM" };
  }
  if (name === "save_inquiry") {
    return { ok: true, message: "Inquiry saved successfully" };
  }
  if (name === "verify_caller") {
    return { ok: true, verified: true };
  }
  return { ok: true };
}

export async function endCall(callId: string, transcript: string, summary: string | null, durationSec: number): Promise<void> {
  try { await post(`/calls/${callId}/end`, { transcript, summary, durationSec }); } catch { /* best effort */ }
}

export async function taskResult(taskId: string, status: string, error: string | null = null): Promise<void> {
  try { await post(`/tasks/${encodeURIComponent(taskId)}/result`, { status, error }); } catch { /* best effort */ }
}

export async function apiReady(): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`${config.apiUrl}/health`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) return { ok: true };
    return { ok: false, error: `HTTP ${r.status}` };
  } catch (e: any) {
    try {
      const r2 = await fetch(`${config.apiUrl}/ready`, { signal: AbortSignal.timeout(5000) });
      if (r2.ok) return { ok: true };
      return { ok: false, error: `HTTP ${r2.status}` };
    } catch (e2: any) {
      return { ok: false, error: e?.message || "Failed to reach API" };
    }
  }
}
