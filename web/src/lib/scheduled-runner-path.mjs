import path from "node:path";

export function scheduledStorePath(root, configuredPath = process.env.CAREER_OPS_SCHEDULED_JOBS_PATH) {
  return configuredPath ? path.resolve(configuredPath) : path.join(root, "data", "scheduled-jobs.json");
}

export function scheduledRunnerResourcePath(storePath) {
  return `${storePath}.runner`;
}
