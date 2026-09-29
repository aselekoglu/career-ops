const READ_ONLY_GETS = new Set([
  "/api/ai/status",
  "/api/explore/ai/known",
]);

const GEMINI_POSTS = new Set([
  "/api/assistant",
  "/api/explore/ai",
]);

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

function isSameOrigin({ origin, host, secFetchSite }) {
  if (typeof origin !== "string" || typeof host !== "string" || secFetchSite !== "same-origin") return false;
  try {
    const parsed = new URL(origin);
    if (!(["https:", "http:"].includes(parsed.protocol)) || parsed.username || parsed.password) return false;
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) return false;
    return parsed.host.toLowerCase() === host.trim().toLowerCase();
  } catch {
    return false;
  }
}

/** Decide which authenticated Vercel API requests may reach read-only AI handlers. */
export function isAllowedCloudAiRequest(request, status) {
  const { pathname, method } = request ?? {};
  if (READ_ONLY_GETS.has(pathname)) {
    return method === "GET"
      ? { allowed: true }
      : { allowed: false, reason: "method_not_allowed" };
  }

  if (GEMINI_POSTS.has(pathname)) {
    if (method !== "POST") return { allowed: false, reason: "method_not_allowed" };
    if (status?.hosted !== true || status?.ready !== true || status?.geminiConfigured !== true) {
      return { allowed: false, reason: "gemini_unavailable" };
    }
    if (!isSameOrigin(request)) return { allowed: false, reason: "same_origin_required" };
    return { allowed: true };
  }

  return { allowed: false, reason: "path_not_allowed" };
}
