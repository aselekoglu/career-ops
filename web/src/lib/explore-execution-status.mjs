import { parseAssistantAiStatus } from "./ai/hosted-assistant-client.mjs";

const UNKNOWN = Object.freeze({ mode: "unknown", hostedReady: false });

/** Accept only a successful, well-formed public status response as execution authority. */
export async function loadExploreExecutionStatus(fetchStatus = fetch) {
  try {
    const response = await fetchStatus("/api/ai/status");
    if (!response?.ok) return UNKNOWN;
    const status = parseAssistantAiStatus(await response.json());
    if (!status) return UNKNOWN;
    if (status.hosted === false) {
      return status.ready === false && status.geminiConfigured === false && status.openaiConfigured === false
        ? { mode: "local", hostedReady: false }
        : UNKNOWN;
    }
    const selectedProviderConfigured = status.provider === "openai" ? status.openaiConfigured : status.geminiConfigured;
    if (status.ready && !selectedProviderConfigured) return UNKNOWN;
    return { mode: "hosted", hostedReady: status.ready && selectedProviderConfigured };
  } catch {
    return UNKNOWN;
  }
}
