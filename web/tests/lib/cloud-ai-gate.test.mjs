import assert from "node:assert/strict";
import { test } from "node:test";
import { isAllowedCloudAiRequest, toPublicHostedAiStatus } from "../../src/lib/ai/cloud-ai-gate.mjs";

const ready = { hosted: true, ready: true, geminiConfigured: true };
const request = (pathname, method = "POST", extra = {}) => ({
  pathname,
  method,
  origin: "https://career-ops.example",
  requestOrigin: "https://career-ops.example",
  host: "career-ops.example",
  requestHost: "career-ops.example",
  secFetchSite: "same-origin",
  ...extra,
});
const readyHandlers = { assistant: true, explore: true, exploreKnown: true };

test("public hosted AI status exposes booleans only and never provider credentials", () => {
  const secret = "gemini-secret-that-must-not-escape";
  const output = toPublicHostedAiStatus({ ready: true, geminiConfigured: true, apiKey: secret, secret }, true);
  assert.deepEqual(output, { hosted: true, ready: true, geminiConfigured: true });
  assert.equal(JSON.stringify(output).includes(secret), false);
  assert.deepEqual(toPublicHostedAiStatus({ ready: true, geminiConfigured: true }, false), {
    hosted: false,
    ready: false,
    geminiConfigured: false,
  });
});

test("status, hosted Explore POST, and known URL GET are enabled only when their handlers are ready", () => {
  const missingKey = { hosted: true, ready: false, geminiConfigured: false };
  assert.equal(isAllowedCloudAiRequest(request("/api/ai/status", "GET"), missingKey).allowed, true);
  assert.equal(isAllowedCloudAiRequest(request("/api/explore/ai/known", "GET"), missingKey).allowed, false);
  assert.equal(isAllowedCloudAiRequest(request("/api/explore/ai/known", "GET"), missingKey, { exploreKnown: true }).allowed, true);
  assert.equal(isAllowedCloudAiRequest(request("/api/explore/ai"), ready, { explore: true }).allowed, true);
  assert.equal(isAllowedCloudAiRequest(request("/api/explore/ai/known", "GET"), ready, { exploreKnown: true }).allowed, true);
});

test("Gemini POSTs require both an adapted hosted handler and configured same-origin provider", () => {
  assert.equal(isAllowedCloudAiRequest(request("/api/assistant"), ready).allowed, false);
  assert.equal(isAllowedCloudAiRequest(request("/api/assistant"), ready, readyHandlers).allowed, true);
  assert.equal(isAllowedCloudAiRequest(request("/api/explore/ai"), ready, readyHandlers).allowed, true);
  assert.equal(isAllowedCloudAiRequest(request("/api/explore/ai"), ready, { explore: false }).allowed, false);
  assert.equal(isAllowedCloudAiRequest(request("/api/explore/ai/known", "GET"), ready, readyHandlers).allowed, true);
  assert.equal(isAllowedCloudAiRequest(request("/api/assistant"), { ...ready, geminiConfigured: false, ready: false }, readyHandlers).allowed, false);
});

test("cross-origin or unverifiable provider POSTs are denied", () => {
  assert.equal(isAllowedCloudAiRequest(request("/api/assistant", "POST", { origin: "https://evil.example" }), ready, readyHandlers).allowed, false);
  assert.equal(isAllowedCloudAiRequest(request("/api/assistant", "POST", { secFetchSite: "cross-site" }), ready, readyHandlers).allowed, false);
  assert.equal(isAllowedCloudAiRequest(request("/api/assistant", "POST", { origin: null }), ready, readyHandlers).allowed, false);
  assert.equal(isAllowedCloudAiRequest(request("/api/assistant", "POST", { secFetchSite: null }), ready, readyHandlers).allowed, false);
});

test("provider POSTs deny a missing Host and a scheme-mismatched Origin", () => {
  assert.equal(isAllowedCloudAiRequest(request("/api/assistant", "POST", { host: null }), ready, readyHandlers).allowed, false);
  assert.equal(isAllowedCloudAiRequest(request("/api/assistant", "POST", { host: "other.example" }), ready, readyHandlers).allowed, false);
  assert.equal(isAllowedCloudAiRequest(request("/api/assistant", "POST", { origin: "http://career-ops.example" }), ready, readyHandlers).allowed, false);
});

test("wrong methods, local execution, and data mutation routes stay denied", () => {
  assert.equal(isAllowedCloudAiRequest(request("/api/ai/status", "POST"), ready).allowed, false);
  assert.equal(isAllowedCloudAiRequest(request("/api/explore/ai/known", "POST"), ready).allowed, false);
  assert.equal(isAllowedCloudAiRequest(request("/api/explore/ai", "GET"), ready, readyHandlers).allowed, false);
  for (const pathname of ["/api/run", "/api/pipeline", "/api/profile", "/api/scheduled-jobs", "/api/assistant/extra", "/api/explore/ai/known/extra"]) {
    assert.equal(isAllowedCloudAiRequest(request(pathname), ready).allowed, false, `${pathname} must stay blocked`);
  }
});
