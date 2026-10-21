import assert from "node:assert/strict";
import test from "node:test";

import { assistantRequestMode, parseAssistantAiStatus } from "../../src/lib/ai/hosted-assistant-client.mjs";
import { loadExploreExecutionStatus } from "../../src/lib/explore-execution-status.mjs";

const openAiStatus = {
  hosted: true,
  ready: true,
  geminiConfigured: false,
  openaiConfigured: true,
  provider: "openai",
};

const fetchStatus = (status) => async (url) => {
  assert.equal(url, "/api/ai/status");
  return { ok: true, json: async () => status };
};

test("hosted Assistant accepts OpenAI-only and explicitly selected providers", () => {
  const parsed = parseAssistantAiStatus(openAiStatus);
  assert.equal(assistantRequestMode(parsed, null), "hosted");

  const selectedGemini = parseAssistantAiStatus({
    hosted: true,
    ready: true,
    geminiConfigured: true,
    openaiConfigured: true,
    provider: "gemini",
  });
  assert.equal(assistantRequestMode(selectedGemini, null), "hosted");

  const selectedOpenAi = parseAssistantAiStatus({
    hosted: true,
    ready: true,
    geminiConfigured: true,
    openaiConfigured: true,
    provider: "openai",
  });
  assert.equal(assistantRequestMode(selectedOpenAi, null), "hosted");
});

test("Assistant stays disabled when the selected provider is unconfigured", () => {
  const status = parseAssistantAiStatus({
    hosted: true,
    ready: false,
    geminiConfigured: true,
    openaiConfigured: false,
    provider: "openai",
  });

  assert.equal(assistantRequestMode(status, null), "disabled");
});

test("Assistant preserves legacy Gemini status and excludes unknown fields", () => {
  const parsed = parseAssistantAiStatus({
    hosted: true,
    ready: true,
    geminiConfigured: true,
    apiKey: "must-not-be-retained",
  });

  assert.deepEqual(parsed, {
    hosted: true,
    ready: true,
    geminiConfigured: true,
    openaiConfigured: false,
    provider: "gemini",
  });
  assert.equal(JSON.stringify(parsed).includes("must-not-be-retained"), false);
  assert.equal(assistantRequestMode(parsed, null), "hosted");
});

test("hosted Explore accepts only the selected, configured OpenAI provider", async () => {
  const ready = await loadExploreExecutionStatus(fetchStatus(openAiStatus));
  const missingSelectedKey = await loadExploreExecutionStatus(fetchStatus({
    hosted: true,
    ready: false,
    geminiConfigured: true,
    openaiConfigured: false,
    provider: "openai",
  }));

  assert.deepEqual(ready, { mode: "hosted", hostedReady: true });
  assert.deepEqual(missingSelectedKey, { mode: "hosted", hostedReady: false });
});
