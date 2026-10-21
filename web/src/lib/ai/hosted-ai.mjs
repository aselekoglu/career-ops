import { GoogleGenAI } from "@google/genai";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_CV_BODY_BYTES = 192 * 1024;
const MAX_EVALUATION_BODY_BYTES = 192 * 1024;
const MAX_HISTORY = 20;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_SYSTEM_CHARS = 16_000;
const MAX_CV_MESSAGE_CHARS = 100_000;
const MAX_EVALUATION_MESSAGE_CHARS = 160_000;
const MAX_CV_SYSTEM_CHARS = 16_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const EVALUATION_TIMEOUT_MS = 90_000;
const MODEL = "gemini-3.8-flash";
const OPENAI_MODEL = "gpt-5-mini";

function hostedAiError(code, message) {
  return Object.assign(new Error(message), { code });
}

function validateInput(input) {
  const invalid = () => hostedAiError("HOSTED_AI_INPUT_TOO_LARGE", "Hosted AI request is invalid or too large.");
  if (!input || !["assistant", "explore", "cv", "evaluation"].includes(input.task)) throw invalid();
  const systemLimit = input.task === "cv" ? MAX_CV_SYSTEM_CHARS : MAX_SYSTEM_CHARS;
  const messageLimit = input.task === "cv" ? MAX_CV_MESSAGE_CHARS : input.task === "evaluation" ? MAX_EVALUATION_MESSAGE_CHARS : MAX_MESSAGE_CHARS;
  if (typeof input.system !== "string" || input.system.length > systemLimit) throw invalid();
  if (typeof input.webSearch !== "boolean") throw invalid();
  if (!Array.isArray(input.messages) || input.messages.length > MAX_HISTORY) throw invalid();
  for (const message of input.messages) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) throw invalid();
    if (typeof message.content !== "string") throw invalid();
    if (message.role === "user" && message.content.length > messageLimit) throw invalid();
  }
  const body = {
    task: input.task,
    system: input.system,
    messages: input.messages,
    webSearch: input.webSearch,
  };
  const bodyLimit = input.task === "cv" ? MAX_CV_BODY_BYTES : input.task === "evaluation" ? MAX_EVALUATION_BODY_BYTES : MAX_BODY_BYTES;
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > bodyLimit) throw invalid();
}

function normalizeProviderError(error, signal, timedOut, providerName = "AI provider") {
  if (error?.code === "HOSTED_AI_OUTPUT_INCOMPLETE") {
    return hostedAiError("HOSTED_AI_OUTPUT_INCOMPLETE", "AI provider stopped before completing the response.");
  }
  if (timedOut()) return hostedAiError("HOSTED_AI_TIMEOUT", "AI provider did not respond in time.");
  if (signal?.aborted) return hostedAiError("HOSTED_AI_ABORTED", "Hosted AI request was cancelled.");
  if (error?.code === "gateway_timeout") {
    return hostedAiError("HOSTED_AI_TIMEOUT", "AI provider did not respond in time.");
  }
  const status = Number(error?.status ?? error?.statusCode ?? error?.code);
  if (status === 401 || status === 403) {
    return hostedAiError("HOSTED_AI_AUTH_ERROR", "AI provider access is unavailable. Check the configured API key and permissions.");
  }
  if (status === 429) {
    return hostedAiError("HOSTED_AI_QUOTA_EXCEEDED", "AI provider quota or rate limit was reached. Try again later.");
  }
  return hostedAiError("HOSTED_AI_PROVIDER_ERROR", "AI provider is temporarily unavailable.");
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
        generation_config: {
          max_output_tokens: input.task === "evaluation" ? 16384 : input.task === "cv" ? 8192 : input.task === "explore" ? 4096 : 2048,
          ...(input.task === "evaluation" ? { thinking_level: "low" } : {}),
        },
        ...(input.task === "explore" && input.webSearch ? { tools: [{ type: "google_search" }] } : {}),
        stream: true,
        store: false,
      }, { signal: input.signal, maxRetries: 0 });
      let completed = false;
      for await (const event of response) {
        if (event?.event_type === "error") {
          throw Object.assign(new Error("Gemini interaction failed."), { code: event.error?.code });
        }
        if (event?.event_type === "interaction.status_update") {
          if (["incomplete", "budget_exceeded", "failed", "cancelled"].includes(event.status)) {
            throw Object.assign(new Error("Gemini evaluation output was incomplete."), { code: "HOSTED_AI_OUTPUT_INCOMPLETE" });
          }
          if (event.status === "completed") completed = true;
        }
        if (event?.event_type === "interaction.completed") {
          if (event.interaction?.status !== "completed") {
            throw Object.assign(new Error("Gemini evaluation output was incomplete."), { code: "HOSTED_AI_OUTPUT_INCOMPLETE" });
          }
          completed = true;
        }
        if (event?.event_type === "step.delta" && event.delta?.type === "text" && event.delta.text) {
          yield { type: "text", text: event.delta.text };
        }
      }
      if (input.task === "evaluation" && !completed) {
        throw Object.assign(new Error("Gemini evaluation stream ended without a completion event."), { code: "HOSTED_AI_OUTPUT_INCOMPLETE" });
      }
    },
  };
}

/** OpenAI Responses adapter. Uses built-in fetch, so no SDK or bundled secret is needed. */
export function createOpenAIProvider({ apiKey, model = OPENAI_MODEL, fetchFn = fetch }) {
  return {
    async *stream(input) {
      const request = {
        model,
        instructions: input.system,
        input: input.messages.map(({ role, content }) => ({ role, content })),
        store: false,
        stream: false,
        max_output_tokens: input.task === "evaluation" ? 20000 : input.task === "cv" ? 16000 : input.task === "explore" ? 4096 : 2048,
        ...(input.task === "explore" && input.webSearch ? { tools: [{ type: "web_search" }] } : {}),
      };
      // The AI service owns timeouts and cancellation; don't log API credentials or responses.
      const response = await fetchFn("https://api.openai.com/v1/responses", {
        method: "POST",
        redirect: "error",
        signal: input.signal,
        headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        throw Object.assign(new Error("OpenAI request failed"), { status: response.status });
      }
      const result = await response.json();
      if (result?.status !== "completed") {
        throw Object.assign(new Error("OpenAI response incomplete"), { code: "HOSTED_AI_OUTPUT_INCOMPLETE" });
      }
      const chunks = (result.output || [])
        .filter(item => item?.type === "message" && item?.role === "assistant")
        .flatMap(item => item.content || [])
        .filter(item => item?.type === "output_text" && typeof item.text === "string")
        .map(item => item.text);
      const content = chunks.join("") || (typeof result.output_text === "string" ? result.output_text : "");
      if (!content.trim()) {
        throw Object.assign(new Error("OpenAI returned no text"), { code: "HOSTED_AI_OUTPUT_INCOMPLETE" });
      }
      yield { type: "text", text: content };
    },
  };
}

/** Create the server-side hosted AI service. No credential values leave this module. */
export function createHostedAiService(options = {}) {
  const env = options.env ?? process.env;
  const geminiKey = typeof env.GEMINI_API_KEY === "string" ? env.GEMINI_API_KEY.trim() : "";
  const openaiKey = typeof env.OPENAI_API_KEY === "string" ? env.OPENAI_API_KEY.trim() : "";
  // An explicit selection is respected. Otherwise, OpenAI takes priority when configured,
  // while legacy Gemini installations continue to work without migration.
  const choice = env.CAREER_OPS_AI_PROVIDER === "openai" || env.CAREER_OPS_AI_PROVIDER === "gemini"
    ? env.CAREER_OPS_AI_PROVIDER
    : (openaiKey ? "openai" : "gemini");
  const configured = choice === "openai" ? Boolean(openaiKey) : Boolean(geminiKey);
  const provider = choice === "openai"
    ? options.openai ?? (openaiKey ? createOpenAIProvider({
      apiKey: openaiKey,
      model: env.OPENAI_MODEL || OPENAI_MODEL,
      fetchFn: options.fetchFn || fetch,
    }) : null)
    : options.gemini ?? (geminiKey ? createGeminiProvider(new GoogleGenAI({ apiKey: geminiKey })) : null);

  return {
    status() {
      return {
        geminiConfigured: Boolean(geminiKey),
        openaiConfigured: Boolean(openaiKey),
        provider: choice,
        ready: configured,
      };
    },
    async *stream(input) {
      if (!configured || !provider) throw hostedAiError("HOSTED_AI_UNAVAILABLE", "Hosted AI provider is not configured.");
      validateInput(input);
      const timeoutMs = options.timeoutMs ?? (input.task === "evaluation" ? EVALUATION_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
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
        throw normalizeProviderError(error, input.signal, () => didTimeOut, choice);
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
