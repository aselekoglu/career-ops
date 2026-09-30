import { hostedAssistantPrompt } from "./hosted-assistant-actions.mjs";

const MAX_BODY_BYTES = 64 * 1024;

export function routeAssistantRequest(request, { isCloud, hosted, local }) {
  return isCloud ? hosted(request) : local(request);
}

async function readBoundedJson(request) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) return { tooLarge: true };
  if (!request.body) return { invalid: true };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return { tooLarge: true };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch { return { invalid: true }; } finally { reader.releaseLock(); }
}

export async function handleHostedAssistantRequest(request, { service, context }) {
  if (!service.status().ready) return Response.json({ error: "Hosted Gemini is not configured." }, { status: 503 });
  const parsed = await readBoundedJson(request);
  if (parsed.tooLarge) return Response.json({ error: "Request is too large." }, { status: 413 });
  if (parsed.invalid || !parsed.value || typeof parsed.value !== "object") return Response.json({ error: "bad json" }, { status: 400 });
  const { message, history, pagePath } = parsed.value;
  if (typeof message !== "string" || !message.trim() || message.length > 8_000 ||
      (history !== undefined && (!Array.isArray(history) || history.length > 8 || history.some((item) =>
        !item || (item.role !== "user" && item.role !== "assistant") || typeof item.content !== "string" || item.content.length > 4_000)))) {
    return Response.json({ error: "Invalid Assistant request." }, { status: 400 });
  }
  let selected;
  try { selected = await context({ message, pagePath }); }
  catch { return Response.json({ error: "Assistant context is unavailable." }, { status: 503 }); }
  const messages = [...(history ?? []), { role: "user", content: message.trim() }];
  const abort = new AbortController();
  const onRequestAbort = () => abort.abort();
  request.signal?.addEventListener("abort", onRequestAbort, { once: true });
  if (request.signal?.aborted) abort.abort();
  const iterator = service.stream({ task: "assistant", system: hostedAssistantPrompt(selected), messages, webSearch: false, signal: abort.signal })[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next();
        if (done) { request.signal?.removeEventListener("abort", onRequestAbort); controller.close(); return; }
        if (value?.type === "text" && typeof value.text === "string") controller.enqueue(encoder.encode(value.text));
      } catch {
        request.signal?.removeEventListener("abort", onRequestAbort);
        if (!abort.signal.aborted) controller.enqueue(encoder.encode("\n⚠️ Hosted assistant is temporarily unavailable."));
        controller.close();
      }
    },
    cancel() { abort.abort(); request.signal?.removeEventListener("abort", onRequestAbort); void iterator.return?.(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
}
