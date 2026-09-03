import path from "node:path";

// Keep this web-boundary copy in runtime parity with ../../../lib/scheduled-runner-path.mjs.
// The app intentionally pins Turbopack's root to web/ for the Windows worker
// stability workaround, so web code cannot import the checkout-level helper.
export function scheduledStorePath(root, configuredPath = process.env.CAREER_OPS_SCHEDULED_JOBS_PATH) {
  if (configuredPath) return path.isAbsolute(configuredPath) ? configuredPath : path.resolve(root, configuredPath);
  return path.join(root, "data", "scheduled-jobs.json");
}

export function scheduledRunnerResourcePath(storePath) {
  return `${storePath}.runner`;
}
