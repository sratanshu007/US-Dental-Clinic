// Load test for the tool API the voice agent depends on. Simulates N callers at once going through
// start -> check_availability -> book_appointment -> end, and prints latency per step.
// The AI's reply time on a real call = this + LLM + speech; keep p95 here under ~300 ms.
//
//   INTERNAL_API_KEY=... API=https://api.yourdomain.com CLINIC_NUMBER=+1... npx tsx scripts/loadtest.ts 20
// Use a test clinic: every run books real appointments in it (they are cancelled at the end).
const API = (process.env.API ?? "http://localhost:4000").replace(/\/$/, "");
const KEY = process.env.INTERNAL_API_KEY ?? "dev-internal-key";
const CLINIC = process.env.CLINIC_NUMBER ?? "+12105550100";
const N = Number(process.argv[2] ?? 10);

const times: Record<string, number[]> = {};
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t = performance.now();
  try { return await fn(); } finally { (times[name] ??= []).push(performance.now() - t); }
}
async function post(path: string, body: unknown) {
  const r = await fetch(`${API}/internal${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Internal-Key": KEY }, body: JSON.stringify(body) });
  if (!r.ok && r.status !== 409) throw new Error(`${path} ${r.status}`);
  return r.json() as Promise<any>;
}

async function caller(i: number) {
  const from = `+1210599${String(1000 + i).slice(-4)}`;
  const s = await step("calls/start", () => post("/calls/start", { direction: "INBOUND", from, to: CLINIC }));
  const a = await step("check_availability", () => post("/tools/check_availability", { callId: s.callId, args: {} }));
  const slot = a.slots[i % Math.max(1, a.slots.length)];
  let booked = false;
  if (slot) {
    const b = await step("book_appointment", () => post("/tools/book_appointment", { callId: s.callId, args: { startAt: slot.startAt, firstName: `Load${i}` } }));
    booked = !!b.ok;
    if (b.ok) {
      await post("/tools/verify_caller", { callId: s.callId, args: { firstName: `Load${i}` } });
      await post("/tools/cancel_appointment", { callId: s.callId, args: { appointmentId: b.appointmentId } });
    }
  }
  await step("calls/end", () => post(`/calls/${s.callId}/end`, { transcript: "load test", summary: "load test", durationSec: 1 }));
  return booked;
}

const pct = (a: number[], p: number) => a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
async function main() {
const started = performance.now();
const results = await Promise.allSettled(Array.from({ length: N }, (_, i) => caller(i)));
const failed = results.filter((r) => r.status === "rejected");
console.log(`\n${N} simultaneous callers in ${Math.round(performance.now() - started)} ms — ${failed.length} failed`);
for (const [name, a] of Object.entries(times)) {
  console.log(`${name.padEnd(20)} p50 ${pct(a, 50).toFixed(0).padStart(5)} ms   p95 ${pct(a, 95).toFixed(0).padStart(5)} ms   max ${Math.max(...a).toFixed(0).padStart(5)} ms`);
}
if (failed.length) console.log("first error:", (failed[0] as PromiseRejectedResult).reason?.message);
process.exit(failed.length ? 1 : 0);
}
void main();
