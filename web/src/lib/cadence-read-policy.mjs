/**
 * Selects the follow-up cadence read source before any source callback runs.
 * Cloud runtimes may read the durable snapshot when configured, but must never
 * fall through to local files when persistence is absent.
 */
export async function readCadenceWithPolicy({
  databaseConfigured,
  cloudRuntime,
  readNeon,
  readLocal,
  cloudDisabled,
}) {
  if (databaseConfigured) return readNeon();
  if (cloudRuntime) return cloudDisabled();
  return readLocal();
}
