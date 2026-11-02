export type HostedAiStatus = {
  geminiConfigured: boolean;
  ready: boolean;
};

export type HostedAiInput = {
  task: "assistant" | "explore";
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  webSearch: boolean;
  signal?: AbortSignal;
};

export type HostedAiEvent = { type: "text"; text: string };

export type HostedAiProvider = {
  stream(input: HostedAiInput): AsyncIterable<HostedAiEvent>;
};

export type HostedAiService = {
  status(): HostedAiStatus;
  stream(input: HostedAiInput): AsyncGenerator<HostedAiEvent>;
};

export function createHostedAiService(options?: {
  env?: NodeJS.ProcessEnv;
  gemini?: HostedAiProvider;
  timeoutMs?: number;
}): HostedAiService;

export function createGeminiProvider(client: {
  interactions: {
    create(request: object, options?: object): Promise<AsyncIterable<object>>;
  };
}): HostedAiProvider;
