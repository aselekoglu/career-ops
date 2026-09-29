import assert from "node:assert/strict";
import { test } from "node:test";
import { isAllowedCloudAiRequest, toPublicHostedAiStatus } from "../../src/lib/ai/cloud-ai-gate.mjs";

const ready = { hosted: true, ready: true, geminiConfigured: true };
const request = (pathname, method = "POST", extra = {}) => ({
  pathname,
  method,
  origin: "https://career-ops.example",
  host: "career-ops.example",
  secFetchSite: "same-origin",
  ...extra,
});

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

test("authenticated read-only status and known-URL GETs are allowed without a Gemini key", () => {
  const missingKey = { hosted: true, ready: false, geminiConfigured: false };
  assert.equal(isAllowedCloudAiRequest(request("/api/ai/status", "GET"), missingKey).allowed, true);
  assert.equal(isAllowedCloudAiRequest(request("/api/explore/ai/known", "GET"), missingKey).allowed, true);
});

test("Gemini provider POSTs are allowed only when configured and same-origin", () => {
  assert.equal(isAllowedCloudAiRequest(request("/api/assistant"), ready).allowed, true);
  assert.equal(isAllowedCloudAiRequest(request("/api/explore/ai"), ready).allowed, true);
  assert.equal(isAllowedCloudAiRequest(request("/api/assistant"), { ...ready, geminiConfigured: false, ready: false }).allowed, false);
});

test("cross-origin or unverifiable provider POSTs are denied", () => {
  assert.equal(isAllowedCloudAiRequest(request("/api/assistant", "POST", { origin: "https://evil.example" }), ready).allowed, false);
  assert.equal(isAllowedCloudAiRequest(request("/api/assistant", "POST", { secFetchSite: "cross-site" }), ready).allowed, false);
  assert.equal(isAllowedCloudAiRequest(request("/api/assistant", "POST", { origin: null }), ready).allowed, false);
  assert.equal(isAllowedCloudAiRequest(request("/api/assistant", "POST", { secFetchSite: null }), ready).allowed, false);
});

test("wrong methods, local execution, and data mutation routes stay denied", () => {
  assert.equal(isAllowedCloudAiRequest(request("/api/ai/status", "POST"), ready).allowed, false);
  assert.equal(isAllowedCloudAiRequest(request("/api/explore/ai/known", "POST"), ready).allowed, false);
  assert.equal(isAllowedCloudAiRequest(request("/api/explore/ai", "GET"), ready).allowed, false);
  for (const pathname of ["/api/run", "/api/pipeline", "/api/profile", "/api/scheduled-jobs", "/api/assistant/extra", "/api/explore/ai/known/extra"]) {
    assert.equal(isAllowedCloudAiRequest(request(pathname), ready).allowed, false, `${pathname} must stay blocked`);
  }
});
