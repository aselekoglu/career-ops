import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers.mjs";

// The root test suite also runs in installations without the optional web/ tree.
// Import the hosted worker only after checking web/ is actually present.
const hasWeb = existsSync(join(ROOT, "web", "src"));
const { classifyRendererFailure, runCloudCvWorker } = hasWeb
  ? await import("../web/scripts/cloud-cv-worker.mjs")
  : { classifyRendererFailure: () => "CV_RENDER_FAILED", runCloudCvWorker: async () => null };

test("CV worker classifies missing browser separately", { skip: !hasWeb }, () => {
  assert.equal(
    classifyRendererFailure("browserType.launch: Executable doesn't exist at /home/runner/.cache/ms-playwright"),
    "CV_RENDER_BROWSER_LAUNCH_FAILED",
  );
});

test("CV worker identifies missing modules and disk errors", { skip: !hasWeb }, () => {
  assert.equal(classifyRendererFailure("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'playwright'"), "CV_RENDER_MODULE_MISSING");
  assert.equal(classifyRendererFailure("Error: ENOSPC: no space left on device"), "CV_RENDER_DISK_FULL");
});

test("CV worker identifies workspace guard and timeout failures", { skip: !hasWeb }, () => {
  assert.equal(classifyRendererFailure("output escapes the tracker workspace"), "CV_RENDER_WORKSPACE_GUARD");
  assert.equal(classifyRendererFailure("Timeout exceeded while printing PDF"), "CV_RENDER_TIMEOUT");
});

test("CV worker distinguishes document ordering from missing browser libraries", { skip: !hasWeb }, () => {
  assert.equal(
    classifyRendererFailure("PDF generation failed: CV work experience is not in reverse-chronological order"),
    "CV_RENDER_EXPERIENCE_ORDER",
  );
  assert.equal(
    classifyRendererFailure("Host system is missing dependencies to run browsers"),
    "CV_RENDER_MISSING_SYSTEM_LIBRARIES",
  );
  assert.equal(
    classifyRendererFailure("CV section order mismatch: education before projects"),
    "CV_RENDER_SECTION_ORDER",
  );
});

test("CV worker gives private fact-check failures safe categories", { skip: !hasWeb }, () => {
  assert.equal(classifyRendererFailure("Fact check failed: non-metric facts absent from sources: confidential-claim"), "CV_RENDER_UNSUPPORTED_FACT");
  assert.equal(classifyRendererFailure("Fact check failed: metric-like claims absent from sources: private-number"), "CV_RENDER_UNSUPPORTED_METRIC");
  assert.equal(classifyRendererFailure("Fact check failed: forbidden phrases found: private-phrase"), "CV_RENDER_FORBIDDEN_PHRASE");
  assert.equal(classifyRendererFailure("Fact check failed"), "CV_RENDER_FACT_VALIDATION");
});

test("CV worker never exposes input stderr or CV contents in failure codes", { skip: !hasWeb }, () => {
  const secret = "PRIVATE_CV_TEXT secret_token_123";
  const classified = classifyRendererFailure("Error: " + secret);
  assert.equal(classified, "CV_RENDER_FAILED");
  assert.ok(!classified.includes(secret));
});

test("CV worker sends a classified render failure code without renderer text", { skip: !hasWeb }, async () => {
  const runId = "55555555-5555-4555-8555-555555555555";
  const lease = "66666666-6666-4666-8666-666666666666";
  const requests = [];
  const fetchFn = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    return body.action === "claim"
      ? Response.json({ runId, lease, html: "invalid renderer fixture", format: "letter" })
      : Response.json({ runId, status: "failed", errorCode: body.errorCode || "CV_WORKER_FAILED" });
  };

  await assert.rejects(runCloudCvWorker({
    id: runId,
    secret: "worker-secret",
    fetchFn,
    renderFn: async () => { throw new Error("Timeout exceeded while printing PDF: private CV claim"); },
  }));

  assert.equal(requests[1].action, "fail");
  assert.equal(requests[1].errorCode, "CV_RENDER_TIMEOUT");
  assert.ok(!JSON.stringify(requests).includes("private CV claim"));
});
