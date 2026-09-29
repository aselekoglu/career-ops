import { GoogleGenAI } from "@google/genai";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_HISTORY = 20;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_SYSTEM_CHARS = 16_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MODEL = "gemini-3.8-flash";

function hostedAiError(code, message) {
  return Object.assign(new Error(message), { code });
}

function validateInput(input) {
  const invalid = () => hostedAiError("HOSTED_AI_INPUT_TOO_LARGE", "Hosted AI request is invalid or too large.");
  if (!input || (input.task !== "assistant" && input.task !== "explore")) throw invalid();
  if (typeof input.system !== "string" || input.system.length > MAX_SYSTEM_CHARS) throw invalid();
  if (typeof input.webSearch !== "boolean") throw invalid();
  if (!Array.isArray(input.messages) || input.messages.length > MAX_HISTORY) throw invalid();
  for (const message of input.messages) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) throw invalid();
    if (typeof message.content !== "string" || message.content.length > MAX_MESSAGE_CHARS) throw invalid();
  }
  const body = {
    task: input.task,
    system: input.system,
    messages: input.messages,
    webSearch: input.webSearch,
  };
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BODY_BYTES) throw invalid();
}

function normalizeProviderError(error, signal, timedOut) {
  if (timedOut()) return hostedAiError("HOSTED_AI_TIMEOUT", "Gemini did not respond in time.");
  if (signal?.aborted) return hostedAiError("HOSTED_AI_ABORTED", "Hosted AI request was cancelled.");
  const status = Number(error?.status ?? error?.statusCode ?? error?.code);
  if (status === 401 || status === 403) {
    return hostedAiError("HOSTED_AI_AUTH_ERROR", "Gemini access is unavailable. Check the configured API key and permissions.");
  }
  if (status === 429) {
    return hostedAiError("HOSTED_AI_QUOTA_EXCEEDED", "Gemini quota or rate limit was reached. Try again later.");
  }
  return hostedAiError("HOSTED_AI_PROVIDER_ERROR", "Gemini is temporarily unavailable.");
}

/** Adapt the Google GenAI Interactions stream to the hosted text contract. */
export function createGeminiProvider(client) {
  return {
    async *stream(input) {
      const history = input.messages.map((message) => ({
        type: message.role === "user" ? "user_input" : "model_output",
        content: [{ type: "text", text: message.content }],
      }));
      const response = await client.interactions.create({
        model: MODEL,
        input: history,
        system_instruction: input.system,
        generation_config: { max_output_tokens: input.task === "explore" ? 4096 : 2048 },
        ...(input.task === "explore" && input.webSearch ? { tools: [{ type: "google_search" }] } : {}),
        stream: true,
        store: false,
      }, { signal: input.signal, maxRetries: 0 });
      for await (const event of response) {
        if (event?.event_type === "step.delta" && event.delta?.type === "text" && event.delta.text) {
          yield { type: "text", text: event.delta.text };
        }
      }
    },
  };
}

/** Create the server-side Gemini service. No credential values leave this module. */
export function createHostedAiService(options = {}) {
  const env = options.env ?? process.env;
  const apiKey = typeof env.GEMINI_API_KEY === "string" ? env.GEMINI_API_KEY.trim() : "";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const provider = options.gemini ?? (apiKey ? createGeminiProvider(new GoogleGenAI({ apiKey })) : null);

  return {
    status() {
      return { geminiConfigured: Boolean(apiKey), ready: Boolean(apiKey) };
    },
    async *stream(input) {
      if (!apiKey) throw hostedAiError("HOSTED_AI_UNAVAILABLE", "Gemini is not configured.");
      validateInput(input);
      const controller = new AbortController();
      let didTimeOut = false;
      const onAbort = () => controller.abort();
      input.signal?.addEventListener("abort", onAbort, { once: true });
      if (input.signal?.aborted) controller.abort();
      const timer = setTimeout(() => {
        didTimeOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        for await (const event of provider.stream({ ...input, signal: controller.signal })) {
          if (controller.signal.aborted) {
            throw hostedAiError("HOSTED_AI_ABORTED", "Hosted AI request was cancelled.");
          }
          if (event?.type === "text" && typeof event.text === "string" && event.text) yield event;
        }
        if (controller.signal.aborted) {
          throw hostedAiError("HOSTED_AI_ABORTED", "Hosted AI request was cancelled.");
        }
      } catch (error) {
        throw normalizeProviderError(error, input.signal, () => didTimeOut);
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
