// Client for the Node API's /internal endpoints (same contract the Python agent used).
import { config } from "./config";

const headers = { "Content-Type": "application/json", "X-Internal-Key": config.internalApiKey };

async function post(path: string, body: unknown, timeoutMs = 10_000): Promise<Response> {
  return fetch(`${config.apiUrl}/internal${path}`, {
    method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
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

export async function startCall(direction: string, from: string, to: string, plivoCallUuid: string | null, taskId?: string | null): Promise<Session> {
  const r = await post("/calls/start", { direction, from, to, plivoCallUuid, taskId: taskId ?? null });
  if (!r.ok) throw new Error(`calls/start ${r.status}`);
  return (await r.json()) as Session;
}

/** Run an AI tool on the API. Errors come back as {ok:false,error} so the AI can recover. */
export async function tool(name: string, callId: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const clean = Object.fromEntries(Object.entries(args ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== ""));
  try {
    const r = await post(`/tools/${encodeURIComponent(name)}`, { callId, args: clean });
    if (r.status >= 400) {
      let error = "Request failed";
      try { error = ((await r.json()) as any).error ?? error; } catch { /* ignore */ }
      return { ok: false, error };
    }
    return (await r.json()) as Record<string, any>;
  } catch {
    return { ok: false, error: "The scheduling system is not responding. Offer to have the front desk call back." };
  }
}

export async function endCall(callId: string, transcript: string, summary: string | null, durationSec: number): Promise<void> {
  try { await post(`/calls/${callId}/end`, { transcript, summary, durationSec }); } catch { /* best effort */ }
}

export async function taskResult(taskId: string, status: string, error: string | null = null): Promise<void> {
  try { await post(`/tasks/${encodeURIComponent(taskId)}/result`, { status, error }); } catch { /* best effort */ }
}

export async function apiReady(): Promise<boolean> {
  try {
    const r = await fetch(`${config.apiUrl}/ready`, { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch { return false; }
}
