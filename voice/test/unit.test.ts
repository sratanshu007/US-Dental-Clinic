import { test } from "node:test";
import assert from "node:assert/strict";
process.env.INTERNAL_API_KEY ??= "x";
process.env.OPENAI_MODEL ??= "m";

test("sentence splitter speaks complete sentences only", async () => {
  const { SentenceSplitter } = await import("../src/llm");
  const s = new SentenceSplitter();
  assert.deepEqual(s.push("Hi there, this is Dr. Lopez's office. I have 2"), ["Hi there, this is Dr. Lopez's office."]);
  assert.deepEqual(s.push(".30 PM open. Does that work? "), ["I have 2.30 PM open.", "Does that work?"]);
  assert.equal(s.flush(), null);
});

test("every greeting says who's calling, that it's recorded for monitoring, and that it's an AI", async () => {
  const { withDisclosure, disclosure, openingLine } = await import("../src/prompts");
  const d = disclosure("Smile Dental");
  assert.match(d, /This call is from Smile Dental/);
  assert.match(d, /recording this call for monitoring purposes/);
  assert.equal(withDisclosure("Thank you for calling Smile Dental. How can I help you today?", "Smile Dental"), `Thank you for calling Smile Dental. ${d} How can I help you today?`);
  const own = "Hi, Smile Dental, this is the AI assistant and calls are recorded. How can I help?";
  assert.equal(withDisclosure(own, "Smile Dental"), own);
  const out = openingLine({ purpose: "NO_SHOW_REBOOK", clinic: { name: "Smile Dental" }, patient: { firstName: "Ana" } } as any);
  assert.match(out, /^Hi, this call is from Smile Dental, and we're recording this call for monitoring purposes\./);
  assert.match(out, /Am I speaking with Ana\?$/);
});

test("tools per call type", async () => {
  const { toolsFor } = await import("../src/tools");
  const names = (p: string, t: boolean) => toolsFor(p, t).map((x) => x.function.name);
  assert.ok(names("RECEPTION", true).includes("transfer_to_staff"));
  assert.ok(!names("RECEPTION", false).includes("transfer_to_staff"));
  assert.ok(names("RECEPTION", false).includes("verify_caller"));
  assert.ok(names("FEEDBACK", false).includes("save_feedback"));
  assert.ok(!names("NO_SHOW_REBOOK", false).includes("cancel_appointment"));
});

test("hours text", async () => {
  const { hoursText } = await import("../src/prompts");
  const t = hoursText({ mon: [["08:00", "12:30"], ["13:30", "17:00"]] });
  assert.match(t, /Monday: 8 AM to 12:30 PM, 1:30 PM to 5 PM/);
  assert.match(t, /Sunday: closed/);
});
