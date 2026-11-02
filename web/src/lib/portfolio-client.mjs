export class PortfolioClientError extends Error {
  constructor(code, status, message = code) {
    super(message);
    this.name = "PortfolioClientError";
    this.code = code;
    this.status = status;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function portfolioRunMode(sourceMode) {
  return sourceMode === "portfolio" ? "edit" : "generate";
}

/** Keep one id per logical mutation until it succeeds; retries must keep the same payload. */
export function createPortfolioOperationKeys(makeId = () => crypto.randomUUID()) {
  const pending = new Map();
  return {
    begin(slot, payload) {
      const signature = stableJson(payload);
      const previous = pending.get(slot);
      if (previous?.signature === signature) return previous.operationId;
      const operationId = makeId();
      pending.set(slot, { operationId, signature });
      return operationId;
    },
    complete(slot, operationId) {
      if (pending.get(slot)?.operationId === operationId) pending.delete(slot);
    },
    clear(slot) { pending.delete(slot); },
  };
}

export function portfolioErrorMessage(code, status) {
  if (/ACTIVE_RUN/i.test(code)) return "This portfolio has a draft or render in progress. Review or cancel that run, then retry.";
  if (status === 409 || /REVISION|STALE|CONFLICT/i.test(code)) {
    return "This portfolio changed in another session. Refresh it, review the latest version, and try your edit again.";
  }
  if (/SOURCE|FACTS|CLAIM/i.test(code)) {
    return "Source review is required before this draft can be rendered. Review each flagged claim and retry.";
  }
  if (/AUTH|UNAUTHORIZED|FORBIDDEN/i.test(code)) return "Your owner session could not authorize this request. Sign in again and retry.";
  return code.replace(/^PORTFOLIO_/, "").replaceAll("_", " ").toLowerCase() || "Request failed";
}

export async function portfolioRequest(route, init = {}) {
  const response = await fetch(route, {
    cache: "no-store",
    ...init,
    headers: { ...(init.headers || {}) },
  });
  const mime = response.headers.get("content-type") || "";
  const payload = mime.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    const code = typeof payload?.code === "string" ? payload.code : "REQUEST_FAILED";
    throw new PortfolioClientError(code, response.status, portfolioErrorMessage(code, response.status));
  }
  return payload;
}
