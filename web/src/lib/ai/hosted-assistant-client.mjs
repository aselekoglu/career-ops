/** Only a complete status response can choose a local or hosted Assistant path. */
export function parseAssistantAiStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.hosted !== "boolean" || typeof value.ready !== "boolean" || typeof value.geminiConfigured !== "boolean") return null;
  if (value.openaiConfigured !== undefined && typeof value.openaiConfigured !== "boolean") return null;
  if (value.provider !== undefined && value.provider !== null && !["openai", "gemini"].includes(value.provider)) return null;
  if (value.hosted && value.provider === null) return null;

  const openaiConfigured = value.openaiConfigured === true;
  const provider = value.provider === "openai" || value.provider === "gemini"
    ? value.provider
    : (openaiConfigured ? "openai" : "gemini");
  const selectedProviderConfigured = provider === "openai" ? openaiConfigured : value.geminiConfigured;
  if (value.hosted && value.ready && !selectedProviderConfigured) return null;
  return {
    hosted: value.hosted,
    ready: value.ready,
    geminiConfigured: value.geminiConfigured,
    openaiConfigured,
    provider,
  };
}

export function assistantRequestMode(status, cliId) {
  const parsed = parseAssistantAiStatus(status);
  if (!parsed) return "disabled";
  if (parsed.hosted) {
    const selectedProviderConfigured = parsed.provider === "openai" ? parsed.openaiConfigured : parsed.geminiConfigured;
    return parsed.ready && selectedProviderConfigured ? "hosted" : "disabled";
  }
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
