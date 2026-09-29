import assert from "node:assert/strict";
import test from "node:test";

const hostedAi = await import(new URL("../../src/lib/ai/hosted-ai.mjs", import.meta.url));
const { createHostedAiService, createGeminiProvider } = hostedAi;

const request = {
  task: "assistant",
  system: "Help with a job search.",
  messages: [{ role: "user", content: "Hello" }],
  webSearch: false,
};

async function collect(source) {
  const events = [];
  for await (const event of source) events.push(event);
  return events;
}

test("missing Gemini key reports unavailable without a provider call", async () => {
  assert.equal(typeof createHostedAiService, "function");
  let calls = 0;
  const service = createHostedAiService({
    env: {},
    gemini: { async *stream() { calls++; yield { type: "text", text: "wrong" }; } },
  });
  assert.deepEqual(service.status(), { geminiConfigured: false, ready: false });
  await assert.rejects(collect(service.stream(request)), { code: "HOSTED_AI_UNAVAILABLE" });
  assert.equal(calls, 0);
});

test("configured Gemini key reports ready and streams text events", async () => {
  const seen = [];
  const service = createHostedAiService({
    env: { GEMINI_API_KEY: "test-key" },
    gemini: {
      async *stream(input) {
        seen.push(input);
        yield { type: "text", text: "One" };
        yield { type: "text", text: " two" };
      },
    },
  });
  assert.deepEqual(service.status(), { geminiConfigured: true, ready: true });
  assert.deepEqual(await collect(service.stream(request)), [
    { type: "text", text: "One" },
    { type: "text", text: " two" },
  ]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].task, "assistant");
  assert.equal(typeof seen[0].signal?.aborted, "boolean");
});

test("Gemini Interactions disables storage and caps Assistant output", async () => {
  const requests = [];
  const provider = createGeminiProvider({
    interactions: {
      create: async (input) => {
        requests.push(input);
        return (async function* () {
          yield { event_type: "step.delta", delta: { type: "text", text: "Answer" } };
        })();
      },
    },
  });
  assert.deepEqual(await collect(provider.stream(request)), [{ type: "text", text: "Answer" }]);
  assert.equal(requests[0].store, false);
  assert.equal(requests[0].stream, true);
  assert.equal(requests[0].generation_config.max_output_tokens, 2048);
  assert.equal(requests[0].system_instruction, request.system);
  assert.equal(requests[0].tools, undefined);
});

test("Gemini Search is enabled only for Explore and output is capped at 4096 tokens", async () => {
  const requests = [];
  const provider = createGeminiProvider({
    interactions: {
      create: async (input) => {
        requests.push(input);
        return (async function* () {
          yield { event_type: "step.delta", delta: { type: "text", text: "Found" } };
        })();
      },
    },
  });
  assert.deepEqual(await collect(provider.stream({ ...request, task: "explore", webSearch: true })), [
    { type: "text", text: "Found" },
  ]);
  assert.deepEqual(requests[0].tools, [{ type: "google_search" }]);
  assert.equal(requests[0].generation_config.max_output_tokens, 4096);
  await collect(provider.stream({ ...request, webSearch: true }));
  assert.equal(requests[1].tools, undefined);
});

test("request bounds reject oversized history, user text, system context, and body", async () => {
  let calls = 0;
  const service = createHostedAiService({
    env: { GEMINI_API_KEY: "test-key" },
    gemini: { async *stream() { calls++; yield { type: "text", text: "wrong" }; } },
  });
  for (const oversized of [
    { ...request, messages: Array.from({ length: 21 }, () => ({ role: "user", content: "x" })) },
    { ...request, messages: [{ role: "user", content: "x".repeat(8001) }] },
    { ...request, system: "x".repeat(16001) },
    { ...request, system: "x".repeat(16000), messages: Array.from({ length: 20 }, () => ({ role: "assistant", content: "x".repeat(3000) })) },
  ]) {
    await assert.rejects(collect(service.stream(oversized)), { code: "HOSTED_AI_INPUT_TOO_LARGE" });
  }
  assert.equal(calls, 0);
});

test("provider timeout aborts the stream and returns a safe error", async () => {
  const service = createHostedAiService({
    env: { GEMINI_API_KEY: "test-key" },
    timeoutMs: 10,
    gemini: {
      async *stream(input) {
        await new Promise((resolve) => input.signal.addEventListener("abort", resolve, { once: true }));
        throw new Error("raw provider timeout detail");
      },
    },
  });
  await assert.rejects(collect(service.stream(request)), (error) => {
    assert.equal(error.code, "HOSTED_AI_TIMEOUT");
    assert.doesNotMatch(error.message, /raw provider timeout detail/);
    return true;
  });
});

for (const [status, code] of [[401, "HOSTED_AI_AUTH_ERROR"], [403, "HOSTED_AI_AUTH_ERROR"], [429, "HOSTED_AI_QUOTA_EXCEEDED"]]) {
  test("Gemini " + status + " error is clear and does not expose provider details", async () => {
    const service = createHostedAiService({
      env: { GEMINI_API_KEY: "secret-value" },
      gemini: { async *stream() { throw Object.assign(new Error("secret-value private details"), { status }); } },
    });
    await assert.rejects(collect(service.stream(request)), (error) => {
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /secret-value|private details/);
      return true;
    });
  });
}
