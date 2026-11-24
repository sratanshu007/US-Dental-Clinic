// One-off check: our V3 signature must match the official Plivo SDK exactly.
process.env.INTERNAL_API_KEY = "x";
require("tsx/cjs");
const sdk = require("plivo");
const ours = require("../src/plivo.ts");
const token = "MAtokenTEST1234567890";
const cases = [
  ["POST", "https://voice.example.com/plivo/answer", { CallUUID: "abc-123", From: "+12105550100", To: "+18305550100", Direction: "inbound" }],
  ["POST", "https://voice.example.com/plivo/hangup?task=t_1", { CallUUID: "x", CallStatus: "completed" }],
  ["GET", "https://voice.example.com/plivo/outbound-answer?task=t_9&b=2", { CallUUID: "q", From: "+1", To: "+2" }],
  ["GET", "https://voice.example.com/plivo/transfer-xml?t=abc", {}],
  ["POST", "https://voice.example.com/plivo/answer", {}],
];
let ok = 0, fail = 0;
for (const [m, u, p] of cases) for (const nonce of ["12345", "n0nce-xyz"]) {
  const sig = ours.v3Expected(m, u, nonce, token, p);
  const a = sdk.validateV3Signature(m, u, nonce, token, sig, p);
  const b = sdk.validateV3Signature(m, u, nonce, token, "AAAA" + sig.slice(4), p) === ours.validV3Signature(m, u, nonce, token, "AAAA" + sig.slice(4), p);
  const c = sdk.validateV3Signature(m, u, nonce, token, `other,${sig}`, p) && ours.validV3Signature(m, u, nonce, token, `other,${sig}`, p);
  if (a && b && c) ok++; else { fail++; console.log("MISMATCH", m, u, nonce, a, b, c); }
}
console.log(`signature vectors: ${ok} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
