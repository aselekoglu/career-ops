// Hosted handler readiness is supplied explicitly by proxy.ts. Keep unlisted or
// not-yet-implemented capabilities denied by default.

/** Project provider state onto the deliberately small, secret-free public shape. */
export function toPublicHostedAiStatus(status, hosted) {
  const isHosted = hosted === true;
  const geminiConfigured = isHosted && status?.geminiConfigured === true;
  return {
    hosted: isHosted,
    ready: isHosted && status?.ready === true && geminiConfigured,
    geminiConfigured,
  };
}

function isSameOrigin({ origin, requestOrigin, host, requestHost, secFetchSite }) {
  if (
    typeof origin !== "string" ||
    typeof requestOrigin !== "string" ||
    typeof host !== "string" ||
    typeof requestHost !== "string" ||
    secFetchSite !== "same-origin"
  ) return false;
  try {
    const parsed = new URL(origin);
    if (!(["https:", "http:"].includes(parsed.protocol)) || parsed.username || parsed.password) return false;
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) return false;
    const normalizedHost = host.trim().toLowerCase();
    const normalizedRequestHost = requestHost.trim().toLowerCase();
    return origin === parsed.origin &&
      parsed.origin === requestOrigin &&
      normalizedHost === normalizedRequestHost &&
      parsed.host.toLowerCase() === normalizedRequestHost;
  } catch {
    return false;
  }
}

/** Decide which authenticated Vercel requests may reach enabled hosted AI handlers. */
export function isAllowedCloudAiRequest(request, status, handlerReadiness = {}) {
  const { pathname, method } = request ?? {};
  if (pathname === "/api/ai/status") {
    return method === "GET"
      ? { allowed: true }
      : { allowed: false, reason: "method_not_allowed" };
  }

  if (pathname === "/api/explore/ai/known") {
    if (method !== "GET") return { allowed: false, reason: "method_not_allowed" };
    return handlerReadiness.exploreKnown === true
      ? { allowed: true }
      : { allowed: false, reason: "hosted_handler_unavailable" };
  }

  if (pathname === "/api/assistant" || pathname === "/api/explore/ai") {
    if (method !== "POST") return { allowed: false, reason: "method_not_allowed" };
    const handlerReady = pathname === "/api/assistant"
      ? handlerReadiness.assistant === true
      : handlerReadiness.explore === true;
    if (!handlerReady) return { allowed: false, reason: "hosted_handler_unavailable" };
    if (status?.hosted !== true || status?.ready !== true || status?.geminiConfigured !== true) {
      return { allowed: false, reason: "gemini_unavailable" };
    }
    if (!isSameOrigin(request)) return { allowed: false, reason: "same_origin_required" };
    return { allowed: true };
  }

  return { allowed: false, reason: "path_not_allowed" };
}
