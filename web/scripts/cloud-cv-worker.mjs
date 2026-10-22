#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { isMainModule } from "../../lib/is-main-module.mjs";

const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const API = "https://career-ops-aselekoglu.vercel.app/api/cv-worker";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Only emit predefined diagnostic codes. Renderer output may contain personal CV data.
export function classifyRendererFailure(stderr = "") {
  const message = String(stderr);
  if (/ENOSPC|no space left on device/i.test(message)) return "CV_RENDER_DISK_FULL";
  if (/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find module/i.test(message)) return "CV_RENDER_MODULE_MISSING";
  if (/CV work experience is not in reverse-chronological order/i.test(message)) {
    return "CV_RENDER_EXPERIENCE_ORDER";
  }
  if (/CV section order|section order does not match|section order mismatch/i.test(message)) {
    return "CV_RENDER_SECTION_ORDER";
  }
  if (/Host system is missing dependencies to run browsers|Missing libraries|error while loading shared libraries/i.test(message)) {
    return "CV_RENDER_MISSING_SYSTEM_LIBRARIES";
  }
  if (/Executable doesn't exist|browserType[.]launch|Failed to launch chromium|browser has been closed/i.test(message)) {
    return "CV_RENDER_BROWSER_LAUNCH_FAILED";
  }
  if (/escapes the tracker workspace|could not be canonicalized against the tracker workspace/i.test(message)) {
    return "CV_RENDER_WORKSPACE_GUARD";
  }
  if (/fact check failed|CV fact check|unverified numerical claim|unsupported metric/i.test(message)) {
    return "CV_RENDER_FACT_VALIDATION";
  }
  if (/timed out|timeout exceeded/i.test(message)) return "CV_RENDER_TIMEOUT";
  return "CV_RENDER_FAILED";
}

function safeWorkerErrorCode(error) {
  const value = String(error?.message || "");
  return /^CV_[A-Z0-9_]{3,80}$/.test(value) ? value : "CV_WORKER_UNEXPECTED_ERROR";
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || CODE_ROOT,
      env: options.env || process.env,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    // Keep enough stderr to classify the failure, but never log CV content.
    let stderr = "";
    child.stderr?.on("data", chunk => {
      stderr = (stderr + String(chunk)).slice(-24000);
    });
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      if (!settled) {
        settled = true;
        reject(new Error("CV_RENDER_TIMEOUT"));
      }
    }, 8 * 60 * 1000);
    child.once("error", () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error("CV_RENDER_START_FAILED"));
      }
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      code === 0 ? resolve() : reject(new Error(classifyRendererFailure(stderr)));
    });
  });
}

export async function renderClaim(claim) {
  if (!claim || !UUID_RE.test(claim.runId || "") || !UUID_RE.test(claim.lease || "")) {
    throw new Error("INVALID_CV_WORKER_CLAIM");
  }
  if (typeof claim.html !== "string" || !claim.html.includes("</html>")) {
    throw new Error("INVALID_CV_WORKER_CLAIM");
  }
  if (!["letter", "a4"].includes(claim.format)) throw new Error("INVALID_CV_WORKER_CLAIM");

  const outputDir = path.join(CODE_ROOT, "output");
  const configDir = path.join(CODE_ROOT, "config");
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(configDir, { recursive: true });

  const inputPath = path.join(outputDir, ".cloud-cv-" + claim.runId + ".html");
  const outputPath = path.join(outputDir, ".cloud-cv-" + claim.runId + ".pdf");
  await fs.writeFile(inputPath, claim.html, "utf8");
  if (typeof claim.cv === "string" && claim.cv) await fs.writeFile(path.join(CODE_ROOT, "cv.md"), claim.cv, "utf8");
  if (typeof claim.profile === "string" && claim.profile) await fs.writeFile(path.join(configDir, "profile.yml"), claim.profile, "utf8");

  try {
    await runProcess(process.execPath, [
      path.join(CODE_ROOT, "generate-pdf.mjs"),
      inputPath,
      outputPath,
      "--format=" + claim.format,
      "--allow-reorder",
      "--max-pages=2",
    ]);
    const pdf = await fs.readFile(outputPath);
    if (pdf.length < 500 || pdf.subarray(0, 4).toString("ascii") !== "%PDF") {
      throw new Error("CV_RENDER_INVALID_PDF");
    }
    return { pdfBase64: pdf.toString("base64"), byteSize: pdf.length };
  } finally {
    await fs.rm(inputPath, { force: true }).catch(() => {});
    await fs.rm(outputPath, { force: true }).catch(() => {});
  }
}

export async function runCloudCvWorker({
  id = process.env.CV_RUN_ID,
  secret = process.env.CAREER_OPS_SCAN_WORKER_SECRET,
  failOnly = false,
  fetchFn = fetch,
} = {}) {
  if (!UUID_RE.test(id || "") || !secret) throw new Error("CV_WORKER_CONFIGURATION_INVALID");

  async function callback(action, extra = {}) {
    let response;
    try {
      response = await fetchFn(API, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(45_000),
        headers: {
          Authorization: "Bearer " + secret,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(Object.assign({ action, runId: id }, extra)),
      });
    } catch {
      throw new Error("CV_WORKER_" + action.toUpperCase() + "_NETWORK_ERROR");
    }
    if (action === "claim" && response.status === 409) throw new Error("CV_RUN_NOT_CLAIMABLE");
    if (!response.ok) throw new Error("CV_WORKER_" + action.toUpperCase() + "_HTTP_" + response.status);
    return response.json();
  }

  if (failOnly) return callback("fail");

  let lease = null;
  let stage = "claim";
  try {
    const claim = await callback("claim");
    lease = claim.lease;
    stage = "render";
    const receipt = await renderClaim(claim);
    stage = "complete";
    const result = await callback("complete", { lease, receipt });
    console.log(JSON.stringify({
      runId: id,
      status: result.status,
      artifactPath: result.artifactPath || null,
    }));
    return result;
  } catch (error) {
    // Log only constant error codes and a fixed stage, never HTTP bodies or CV text.
    console.error(JSON.stringify({
      event: "career_ops_cv_worker_failed",
      stage,
      code: safeWorkerErrorCode(error),
    }));
    if (error.message !== "CV_RUN_NOT_CLAIMABLE") {
      try { await callback("fail", { lease }); } catch {}
    }
    throw error;
  }
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: node web/scripts/cloud-cv-worker.mjs [--fail]");
  } else {
    runCloudCvWorker({ failOnly: process.argv.includes("--fail") }).catch(() => {
      console.error("Career Ops CV worker failed. Check the durable CV run status.");
      process.exitCode = 1;
    });
  }
}
