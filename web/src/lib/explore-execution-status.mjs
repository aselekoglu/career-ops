const UNKNOWN = Object.freeze({ mode: "unknown", hostedReady: false });

/** Accept only a successful, well-formed public status response as execution authority. */
export async function loadExploreExecutionStatus(fetchStatus = fetch) {
  try {
    const response = await fetchStatus("/api/ai/status");
    if (!response?.ok) return UNKNOWN;
    const status = await response.json();
    if (!status || typeof status !== "object" ||
        typeof status.hosted !== "boolean" || typeof status.ready !== "boolean" ||
        typeof status.geminiConfigured !== "boolean") return UNKNOWN;
    if (status.hosted === false) {
      return status.ready === false && status.geminiConfigured === false
        ? { mode: "local", hostedReady: false }
        : UNKNOWN;
    }
    if (status.ready && !status.geminiConfigured) return UNKNOWN;
    return { mode: "hosted", hostedReady: status.ready && status.geminiConfigured };
  } catch {
    return UNKNOWN;
  }
}
