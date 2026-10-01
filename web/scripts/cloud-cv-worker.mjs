#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const API = "https://career-ops-aselekoglu.vercel.app/api/cv-worker";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || CODE_ROOT,
      env: options.env || process.env,
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
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
      code === 0 ? resolve() : reject(new Error("CV_RENDER_FAILED"));
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
    const response = await fetchFn(API, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(45_000),
      headers: {
        Authorization: "Bearer " + secret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(Object.assign({ action, runId: id }, extra)),
    });
    if (action === "claim" && response.status === 409) throw new Error("CV_RUN_NOT_CLAIMABLE");
    if (!response.ok) throw new Error("CV_WORKER_CALLBACK_FAILED");
    return response.json();
  }

  if (failOnly) return callback("fail");

  let lease = null;
  try {
    const claim = await callback("claim");
    lease = claim.lease;
    const receipt = await renderClaim(claim);
    const result = await callback("complete", { lease, receipt });
    console.log(JSON.stringify({
      runId: id,
      status: result.status,
      artifactPath: result.artifactPath || null,
    }));
    return result;
  } catch (error) {
    if (error.message !== "CV_RUN_NOT_CLAIMABLE") {
      try { await callback("fail", { lease }); } catch {}
    }
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  runCloudCvWorker({ failOnly: process.argv.includes("--fail") }).catch(() => {
    console.error("Career Ops CV worker failed. Check the durable CV run status.");
    process.exitCode = 1;
  });
}
