import test from "node:test";
import assert from "node:assert/strict";
import { classifyRendererFailure } from "../web/scripts/cloud-cv-worker.mjs";

test("CV worker classifies missing browser separately", () => {
  assert.equal(
    classifyRendererFailure("browserType.launch: Executable doesn't exist at /home/runner/.cache/ms-playwright"),
    "CV_RENDER_BROWSER_LAUNCH_FAILED",
  );
});

test("CV worker identifies missing modules and disk errors", () => {
  assert.equal(classifyRendererFailure("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'playwright'"), "CV_RENDER_MODULE_MISSING");
  assert.equal(classifyRendererFailure("Error: ENOSPC: no space left on device"), "CV_RENDER_DISK_FULL");
});

test("CV worker identifies workspace guard and timeout failures", () => {
  assert.equal(classifyRendererFailure("output escapes the tracker workspace"), "CV_RENDER_WORKSPACE_GUARD");
  assert.equal(classifyRendererFailure("Timeout exceeded while printing PDF"), "CV_RENDER_TIMEOUT");
});

test("CV worker never exposes input stderr or CV contents in failure codes", () => {
  const secret = "PRIVATE_CV_TEXT secret_token_123";
  const classified = classifyRendererFailure("Error: " + secret);
  assert.equal(classified, "CV_RENDER_FAILED");
  assert.ok(!classified.includes(secret));
});
