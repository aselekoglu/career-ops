import assert from "node:assert/strict";
import { test } from "node:test";
import { routeAssistantRequest, handleHostedAssistantRequest } from "../../src/lib/ai/hosted-assistant-handler.mjs";
import { buildHostedAssistantContext } from "../../src/lib/ai/hosted-assistant-context.mjs";

const request = (body) => new Request("https://example.test/api/assistant", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

test("cloud Assistant streams hosted provider text without selecting or spawning a CLI", async () => {
  let localCalls = 0;
  const calls = [];
  const response = await routeAssistantRequest(request({ message: "Hello", cliId: "claude", pagePath: "/", pageContext: "PRIVATE BROWSER APPLY FORM" }), {
    isCloud: true,
    local: () => { localCalls++; throw new Error("local CLI selected"); },
    hosted: (req) => handleHostedAssistantRequest(req, {
      service: { status: () => ({ ready: true }), async *stream(input) { calls.push(input); yield { type: "text", text: "Hello " }; yield { type: "text", text: "there" }; } },
      context: async () => ({ cv: "", memory: "", pipeline: "", profile: "", page: "Today" }),
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "Hello there");
  assert.equal(localCalls, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].task, "assistant");
  assert.equal(calls[0].webSearch, false);
  assert.equal(calls[0].messages.at(-1).content, "Hello");
  assert.doesNotMatch(calls[0].system, /PRIVATE BROWSER APPLY FORM/);
});

test("hosted request rejects bodies larger than 64 KiB before JSON parsing", async () => {
  let parsed = false;
  const req = request({ message: "x".repeat(66_000) });
  req.json = async () => { parsed = true; throw new Error("must not parse"); };
  const response = await handleHostedAssistantRequest(req, {
    service: { status: () => ({ ready: true }), stream: () => { throw new Error("provider reached"); } },
    context: async () => ({}),
  });
  assert.equal(response.status, 413);
  assert.equal(parsed, false);
});

test("hosted request bounds streamed bytes even without Content-Length", async () => {
  let providerCalled = false;
  const req = new Request("https://example.test/api/assistant", {
    method: "POST", duplex: "half",
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65_537)); controller.close(); } }),
  });
  const response = await handleHostedAssistantRequest(req, {
    service: { status: () => ({ ready: true }), stream: () => { providerCalled = true; } },
    context: async () => ({}),
  });
  assert.equal(response.status, 413);
  assert.equal(providerCalled, false);
});

test("hosted stream returns a safe message for provider errors", async () => {
  const response = await handleHostedAssistantRequest(request({ message: "Hello" }), {
    service: { status: () => ({ ready: true }), async *stream() { throw new Error("private provider detail"); } },
    context: async () => ({}),
  });
  const output = await response.text();
  assert.match(output, /temporarily unavailable/);
  assert.doesNotMatch(output, /private provider detail/);
});

test("hosted context selects CV only for CV/experience/fit and pipeline only for pipeline questions", async () => {
  const reads = { cv: 0, memory: 0, pipeline: 0, profile: 0 };
  const loaders = {
    readCv: async () => { reads.cv++; return "Experience: TypeScript"; },
    readMemory: async () => { reads.memory++; return "Prefers remote roles"; },
    readPipeline: async () => { reads.pipeline++; return { applications: [], inbox: [] }; },
    readProfile: async () => { reads.profile++; return "candidate:\n  email: private@example.com\ntarget_roles:\n  primary: [Engineer]"; },
  };
  await buildHostedAssistantContext({ message: "Hello", pagePath: "/", ...loaders });
  assert.deepEqual(reads, { cv: 0, memory: 0, pipeline: 0, profile: 0 });
  await buildHostedAssistantContext({ message: "How does my CV fit?", pagePath: "/", ...loaders });
  assert.equal(reads.cv, 1);
  assert.equal(reads.pipeline, 0);
  await buildHostedAssistantContext({ message: "What is next?", pagePath: "/pipeline", ...loaders });
  assert.equal(reads.pipeline, 1);
});

test("hosted context excludes contacts, addresses, URLs and full reports and bounds untrusted text", async () => {
  const context = await buildHostedAssistantContext({
    message: "Review my CV and pipeline", pagePath: "/pipeline/7",
    readCv: async () => `Jane Doe\nEmail: jane@example.com\nPhone: +1 416 555 0199\nAddress: 123 Main Street, Toronto\nExperience\n${"A".repeat(20_000)}`,
    readMemory: async () => "Remember: jane@example.com prefers remote roles",
    readProfile: async () => "candidate:\n  full_name: Jane Doe\n  email: jane@example.com\n  phone: 416-555-0199\n  address: 123 Main Street\ntarget_roles:\n  primary: [Engineer]",
    readPipeline: async () => ({ applications: [{ company: "Acme", role: "Engineer", status: "Applied", score: "4", report: "FULL PRIVATE REPORT", notes: "secret", url: "https://private.example" }], inbox: [{ company: "Acme", role: "Engineer", url: "https://private.example", done: false }] }),
  });
  const raw = JSON.stringify(context);
  for (const forbidden of ["jane@example.com", "416 555 0199", "416-555-0199", "123 Main Street", "FULL PRIVATE REPORT", "https://private.example", "secret"]) assert.equal(raw.includes(forbidden), false, forbidden);
  assert.ok(raw.includes("Engineer"));
  assert.ok(raw.length < 12_000);
});
