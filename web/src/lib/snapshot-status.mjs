const failureStatuses = new Set([
  "broken",
  "unreachable",
  "error",
  "slug_gone",
  "network",
  "auth",
  "server",
  "unknown",
]);

export function mapSnapshotStatus(status) {
  if (status === "reachable" || status === "live") return "live";
  if (status === "empty") return "empty";
  if (failureStatuses.has(status)) return "broken";
  return "skipped";
}
