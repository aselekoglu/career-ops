import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers.mjs";

// The root test suite also runs in installations without the optional web/ tree.
// Import the hosted worker only after checking web/ is actually present.
const hasWeb = existsSync(join(ROOT, "web", "src"));
const { classifyRendererFailure } = hasWeb
  ? await import("../web/scripts/cloud-cv-worker.mjs")
  : { classifyRendererFailure: () => "CV_RENDER_FAILED" };

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

test("CV worker never exposes input stderr or CV contents in failure codes", { skip: !hasWeb }, () => {
  const secret = "PRIVATE_CV_TEXT secret_token_123";
  const classified = classifyRendererFailure("Error: " + secret);
  assert.equal(classified, "CV_RENDER_FAILED");
  assert.ok(!classified.includes(secret));
});
