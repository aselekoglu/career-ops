import assert from "node:assert/strict";
import test from "node:test";

import { isSafeCvRenderErrorCode, normalizeCvWorkerFailureCode } from "../../src/lib/cv-render-errors.mjs";

test("worker renderer failures retain only exact allowlisted codes", () => {
  const allowed = [
    "CV_RENDER_BROWSER_LAUNCH_FAILED", "CV_RENDER_DISK_FULL", "CV_RENDER_EXPERIENCE_ORDER",
    "CV_RENDER_FACT_VALIDATION", "CV_RENDER_FAILED", "CV_RENDER_FORBIDDEN_PHRASE",
    "CV_RENDER_INVALID_PDF", "CV_RENDER_MISSING_SYSTEM_LIBRARIES", "CV_RENDER_MODULE_MISSING",
    "CV_RENDER_SECTION_ORDER", "CV_RENDER_START_FAILED", "CV_RENDER_TIMEOUT",
    "CV_RENDER_UNSUPPORTED_FACT", "CV_RENDER_UNSUPPORTED_METRIC", "CV_RENDER_WORKSPACE_GUARD",
  ];
  for (const code of allowed) {
    assert.equal(isSafeCvRenderErrorCode(code), true, `${code} is a renderer diagnostic`);
    assert.equal(normalizeCvWorkerFailureCode(code), code);
  }

  for (const unsafe of ["CV_RENDER_TIMEOUT private CV text", "CV_WORKER_UNEXPECTED_ERROR", null, 7]) {
    assert.equal(isSafeCvRenderErrorCode(unsafe), false);
    assert.equal(normalizeCvWorkerFailureCode(unsafe), "CV_WORKER_FAILED");
  }
});
