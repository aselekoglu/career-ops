/**
 * Deployment policy for the web UI.
 *
 * The dashboard is intentionally local-first today: it reads user-layer files
 * and can launch local CLI/Playwright processes. Those capabilities cannot be
 * made durable or safe by a serverless filesystem, so cloud deployments must
 * fail closed until an external persistence + worker adapter is configured.
 */
export function isCloudRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VERCEL === "1" || env.CAREER_OPS_RUNTIME === "vercel";
}

export const CLOUD_EXECUTION_MESSAGE =
  "This Career Ops deployment is a protected cloud shell. Local data, scans, scheduler jobs, and application assistance stay disabled until a durable persistence and worker backend is configured.";

export function cloudHealth() {
  const cloud = isCloudRuntime();
  return {
    status: "ok" as const,
    runtime: cloud ? "vercel" : "local",
    execution: cloud ? "disabled-pending-worker" : "local-enabled",
    scheduler: cloud ? "external-worker-required" : "local-task-scheduler",
  };
}
