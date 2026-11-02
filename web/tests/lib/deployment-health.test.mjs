import assert from "node:assert/strict";
import test from "node:test";

import { cloudHealth } from "../../src/lib/deployment.ts";

const workerEnvironment = {
  VERCEL: "1",
  DATABASE_URL: "postgres://career-ops.example/database",
  CAREER_OPS_SCAN_DISPATCH_TOKEN: "dispatch-test-secret",
  CAREER_OPS_SCAN_WORKER_SECRET: "worker-test-secret",
  CAREER_OPS_SCAN_REF: "codex/vercel-hobby-fix",
};

test("cloud health reports the default Gemini provider when only Gemini is configured", () => {
  const health = cloudHealth({ ...workerEnvironment, GEMINI_API_KEY: "gemini-test-secret" });

  assert.equal(health.cvGeneration.available, true);
  assert.equal(health.cvGeneration.ai, "gemini-hosted");
  assert.equal(health.evaluations.available, true);
  assert.equal(health.evaluations.ai, "gemini-hosted");
});

test("cloud health reports explicitly selected OpenAI when both providers are configured", () => {
  const health = cloudHealth({
    ...workerEnvironment,
    GEMINI_API_KEY: "gemini-test-secret",
    OPENAI_API_KEY: "openai-test-secret",
    CAREER_OPS_AI_PROVIDER: "openai",
  });

  assert.equal(health.cvGeneration.available, true);
  assert.equal(health.cvGeneration.ai, "openai-hosted");
  assert.equal(health.evaluations.available, true);
  assert.equal(health.evaluations.ai, "openai-hosted");
});

test("cloud health falls back to configured OpenAI when Gemini is absent", () => {
  const health = cloudHealth({ ...workerEnvironment, OPENAI_API_KEY: "openai-test-secret" });

  assert.equal(health.cvGeneration.available, true);
  assert.equal(health.cvGeneration.ai, "openai-hosted");
  assert.equal(health.evaluations.available, true);
  assert.equal(health.evaluations.ai, "openai-hosted");
});

test("cloud health disables worker capabilities when the selected provider key is missing", () => {
  const health = cloudHealth({
    ...workerEnvironment,
    GEMINI_API_KEY: "gemini-test-secret",
    CAREER_OPS_AI_PROVIDER: "openai",
  });

  assert.equal(health.runtime, "vercel");
  assert.equal(health.scans.available, true);
  assert.equal(health.cvGeneration.available, false);
  assert.equal(health.cvGeneration.ai, null);
  assert.equal(health.evaluations.available, false);
  assert.equal(health.evaluations.ai, null);
});

test("cloud health does not expose provider or worker secrets", () => {
  const health = cloudHealth({
    ...workerEnvironment,
    OPENAI_API_KEY: "openai-test-secret",
    CAREER_OPS_AI_PROVIDER: "openai",
  });
  const serialized = JSON.stringify(health);

  for (const secret of ["openai-test-secret", "dispatch-test-secret", "worker-test-secret", workerEnvironment.DATABASE_URL]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("local health retains local execution and scheduled execution behavior", () => {
  const health = cloudHealth({});

  assert.equal(health.runtime, "local");
  assert.equal(health.scheduledExecution, true);
  assert.equal(health.cvGeneration.available, false);
  assert.equal(health.evaluations.available, false);
});
