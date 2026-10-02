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

test("CV task gets a larger private context budget and an 8192-token output cap", async () => {
  const requests = [];
  const provider = createGeminiProvider({
    interactions: {
      create: async (input) => {
        requests.push(input);
        return (async function* () {
          yield { event_type: "step.delta", delta: { type: "text", text: "CV" } };
        })();
      },
    },
  });
  assert.deepEqual(await collect(provider.stream({ ...request, task: "cv", webSearch: false })), [
    { type: "text", text: "CV" },
  ]);
  assert.equal(requests[0].generation_config.max_output_tokens, 8192);
  assert.equal(requests[0].tools, undefined);

  let calls = 0;
  const service = createHostedAiService({
    env: { GEMINI_API_KEY: "test-key" },
    gemini: { async *stream() { calls++; yield { type: "text", text: "ok" }; } },
  });
  const largeCvRequest = {
    ...request,
    task: "cv",
    messages: [{ role: "user", content: "x".repeat(70_000) }],
  };
  assert.deepEqual(await collect(service.stream(largeCvRequest)), [{ type: "text", text: "ok" }]);
  await assert.rejects(collect(service.stream({
    ...largeCvRequest,
    messages: [{ role: "user", content: "x".repeat(100_001) }],
  })), { code: "HOSTED_AI_INPUT_TOO_LARGE" });
  assert.equal(calls, 1);
});

test("evaluation task accepts bounded canonical context without enabling web search", async () => {
  const requests = [];
  const provider = createGeminiProvider({
    interactions: {
      create: async (input) => {
        requests.push(input);
        return (async function* () {
          yield { event_type: "step.delta", delta: { type: "text", text: "Report" } };
          yield { event_type: "interaction.completed", interaction: { id: "evaluation-1", status: "completed" } };
        })();
      },
    },
  });
  const service = createHostedAiService({ env: { GEMINI_API_KEY: "test-key" }, gemini: provider });
  assert.deepEqual(await collect(service.stream({ ...request, task: "evaluation", messages: [{ role: "user", content: "x".repeat(150_000) }] })), [
    { type: "text", text: "Report" },
  ]);
  assert.equal(requests[0].generation_config.max_output_tokens, 16384);
  assert.equal(requests[0].generation_config.thinking_level, "low");
  assert.equal(requests[0].tools, undefined);
  await assert.rejects(collect(service.stream({ ...request, task: "evaluation", messages: [{ role: "user", content: "x".repeat(160_001) }] })), { code: "HOSTED_AI_INPUT_TOO_LARGE" });
});

test("evaluation rejects truncated text when the terminal interaction status is incomplete", async () => {
  const provider = createGeminiProvider({
    interactions: {
      create: async () => (async function* () {
        yield { event_type: "step.delta", delta: { type: "text", text: "partial A-F report" } };
        yield { event_type: "interaction.completed", interaction: { id: "evaluation-incomplete", status: "incomplete" } };
      })(),
    },
  });
  const service = createHostedAiService({ env: { GEMINI_API_KEY: "test-key" }, gemini: provider });
  const seen = [];
  await assert.rejects(async () => {
    for await (const event of service.stream({ ...request, task: "evaluation" })) seen.push(event);
  }, (error) => {
    assert.equal(error.code, "HOSTED_AI_OUTPUT_INCOMPLETE");
    assert.match(error.message, /stopped before completing/i);
    return true;
  });
  assert.deepEqual(seen, [{ type: "text", text: "partial A-F report" }]);
});

test("evaluation rejects a budget-exceeded status update after text", async () => {
  const provider = createGeminiProvider({
    interactions: {
      create: async () => (async function* () {
        yield { event_type: "step.delta", delta: { type: "text", text: "partial report" } };
        yield { event_type: "interaction.status_update", status: "budget_exceeded", interaction_id: "evaluation-budget" };
      })(),
    },
  });
  const service = createHostedAiService({ env: { GEMINI_API_KEY: "test-key" }, gemini: provider });
  await assert.rejects(collect(service.stream({ ...request, task: "evaluation" })), { code: "HOSTED_AI_OUTPUT_INCOMPLETE" });
});

test("Gemini error event after text fails safely instead of ending successfully", async () => {
  const provider = createGeminiProvider({
    interactions: {
      create: async () => (async function* () {
        yield { event_type: "step.delta", delta: { type: "text", text: "partial" } };
        yield { event_type: "error", error: { code: "gateway_timeout", message: "raw private provider detail" } };
      })(),
    },
  });
  const service = createHostedAiService({ env: { GEMINI_API_KEY: "test-key" }, gemini: provider });
  const seen = [];
  await assert.rejects(async () => {
    for await (const event of service.stream(request)) seen.push(event);
  }, (error) => {
    assert.equal(error.code, "HOSTED_AI_TIMEOUT");
    assert.doesNotMatch(error.message, /raw private provider detail/);
    return true;
  });
  assert.deepEqual(seen, [{ type: "text", text: "partial" }]);
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

test("assistant history over 8000 characters is accepted while user text over 8000 is rejected", async () => {
  const seen = [];
  const service = createHostedAiService({
    env: { GEMINI_API_KEY: "test-key" },
    gemini: {
      async *stream(input) {
        seen.push(input.messages);
        yield { type: "text", text: "ok" };
      },
    },
  });
  const assistantHistory = { ...request, messages: [
    { role: "assistant", content: "x".repeat(8001) },
    { role: "user", content: "Continue" },
  ] };
  assert.deepEqual(await collect(service.stream(assistantHistory)), [{ type: "text", text: "ok" }]);
  await assert.rejects(collect(service.stream({
    ...request,
    messages: [{ role: "user", content: "x".repeat(8001) }],
  })), { code: "HOSTED_AI_INPUT_TOO_LARGE" });
  assert.equal(seen.length, 1);
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
