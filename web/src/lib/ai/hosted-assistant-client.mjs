/** Only a complete status response can choose a local or hosted Assistant path. */
export function parseAssistantAiStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.hosted !== "boolean" || typeof value.ready !== "boolean" || typeof value.geminiConfigured !== "boolean") return null;
  return { hosted: value.hosted, ready: value.ready, geminiConfigured: value.geminiConfigured };
}

export function assistantRequestMode(status, cliId) {
  if (!parseAssistantAiStatus(status)) return "disabled";
  if (status.hosted) return status.ready && status.geminiConfigured ? "hosted" : "disabled";
  return typeof cliId === "string" && cliId ? "local" : "disabled";
}

/** Invalidate old stream work before clearing or closing the visible conversation. */
export function createAssistantTurnGuard() {
  let generation = 0;
  return {
    begin() { return ++generation; },
    invalidate() { generation++; },
    isCurrent(turn) { return turn === generation; },
    run(turn, fn) { if (turn === generation) return fn(); },
  };
}
