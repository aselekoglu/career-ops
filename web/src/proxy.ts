import { NextRequest, NextResponse } from "next/server";
import { CLOUD_EXECUTION_MESSAGE, isCloudRuntime } from "@/lib/deployment";
import { isAllowedCloudAiRequest } from "@/lib/ai/cloud-ai-gate.mjs";
import { workerAuthorized } from "@/lib/cloud-scans.mjs";

const SAFE_CLOUD_API_PATHS = new Set([
  "/api/health",
  "/api/version",
  "/api/pipeline",
  "/api/cv",
  "/api/memory",
  "/api/whats-new",
  "/api/report/shape",
  "/api/scheduled-jobs",
  "/api/scheduler",
  "/api/portals/verify",
  "/api/cv-pdf",
  "/api/clis",
  "/api/followups/cadence",
]);

// Fail closed until each route has a hosted Gemini implementation. Task 3 may
// enable Assistant after its server branch exists; Task 4 owns Explore + Neon URLs.
const HOSTED_AI_HANDLERS = {
  assistant: true,
  explore: true,
  exploreKnown: true,
};

function configuredCredentials() {
  const username = process.env.CAREER_OPS_WEB_AUTH_USER;
  const password = process.env.CAREER_OPS_WEB_AUTH_PASSWORD;
  return username && password ? { username, password } : null;
}

function isAuthorized(request: NextRequest, expected: { username: string; password: string }) {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Basic ")) return false;
  try {
    const decoded = atob(value.slice("Basic ".length));
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;
    return decoded.slice(0, separator) === expected.username && decoded.slice(separator + 1) === expected.password;
  } catch {
    return false;
  }
}

/**
 * Next.js 16 Proxy. This is an intentionally small deployment gate, not a
 * replacement for identity/roles. Enable Vercel Deployment Protection as the
 * primary account-level control; the env-backed Basic challenge makes an
 * accidentally public project fail closed as well.
 */
export function proxy(request: NextRequest) {
  if (!isCloudRuntime()) return NextResponse.next();

  // This bearer credential is scoped to the worker callback only. It cannot
  // reach browser routes, CVs, general mutations or application assistance.
  if (request.nextUrl.pathname === '/api/scan-worker' || request.nextUrl.pathname === '/api/cv-worker' || request.nextUrl.pathname === '/api/evaluation-worker') {
    if (request.method === 'POST' && workerAuthorized(request.headers.get('authorization'))) return NextResponse.next();
    return NextResponse.json({ code: 'WORKER_UNAUTHORIZED' }, { status: 401 });
  }

  const credentials = configuredCredentials();
  if (!credentials) {
    return NextResponse.json(
      { error: "Cloud access is not configured. Set CAREER_OPS_WEB_AUTH_USER and CAREER_OPS_WEB_AUTH_PASSWORD." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (!isAuthorized(request, credentials)) {
    return new NextResponse("Authentication required", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="Career Ops"',
        "Cache-Control": "no-store",
      },
    });
  }

  const pathname = request.nextUrl.pathname;
  if ((pathname === '/api/job-import' && request.method === 'POST') ||
      (pathname === '/api/blacklist' && request.method === 'GET') ||
      (pathname === '/api/blacklist/entry' && request.method === 'GET') ||
      (pathname === '/api/blacklist/commands' && request.method === 'POST') ||
      (pathname === '/api/portals/entries' && request.method === 'GET') ||
      (pathname === '/api/portals/entry' && request.method === 'GET') ||
      (pathname === '/api/portals/commands' && request.method === 'POST') ||
      (/^\/api\/sources\/(?:cv|profile)$/.test(pathname) && request.method === 'GET') ||
      (/^\/api\/sources\/(?:cv|profile)\/proposals$/.test(pathname) && request.method === 'POST') ||
      (/^\/api\/sources\/(?:cv|profile)\/proposals\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pathname) && request.method === 'GET') ||
      (/^\/api\/sources\/(?:cv|profile)\/apply$/.test(pathname) && request.method === 'POST') ||
      (/^\/api\/sources\/(?:cv|profile)\/history$/.test(pathname) && request.method === 'GET') ||
      (/^\/api\/sources\/(?:cv|profile)\/history\/[a-f0-9]{64}$/.test(pathname) && request.method === 'GET') ||
      (pathname === '/api/scans' && request.method === 'POST') ||
      (pathname === '/api/cv-artifacts' && ['GET','HEAD'].includes(request.method)) ||
      (/^\/api\/cv-artifacts\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pathname) && ['GET','HEAD'].includes(request.method)) ||
      (/^\/api\/cv-artifacts\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/associate$/i.test(pathname) && request.method === 'POST') ||
      (/^\/api\/cv-artifacts\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/download$/i.test(pathname) && ['GET','HEAD'].includes(request.method)) ||
      ((pathname === '/api/tracker/commands' || pathname === '/api/inbox/commands') && request.method === 'POST') ||
      (/^\/api\/tracker\/[1-9]\d{0,7}$/.test(pathname) && ['GET','HEAD'].includes(request.method)) ||
      (/^\/api\/scans\/[0-9a-f-]{36}$/i.test(pathname) && ['GET','HEAD'].includes(request.method)) ||
      (pathname === '/api/cv-runs' && request.method === 'POST') ||
      (/^\/api\/cv-runs\/[0-9a-f-]{36}$/i.test(pathname) && ['GET','HEAD'].includes(request.method)) ||
      (pathname === '/api/evaluation-runs' && request.method === 'POST') ||
      (/^\/api\/evaluation-runs\/[0-9a-f-]{36}(?:\/report)?$/i.test(pathname) && ['GET','HEAD'].includes(request.method))) return NextResponse.next();
  const hostedStatus = {
    hosted: true,
    ready: Boolean(process.env.GEMINI_API_KEY?.trim()),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY?.trim()),
  };
  if (pathname === "/api/ai/status" || pathname === "/api/explore/ai/known" || pathname === "/api/assistant" || pathname === "/api/explore/ai") {
    const decision = isAllowedCloudAiRequest({
      pathname,
      method: request.method,
      origin: request.headers.get("origin"),
      requestOrigin: request.nextUrl.origin,
      host: request.headers.get("host"),
      requestHost: request.nextUrl.host,
      secFetchSite: request.headers.get("sec-fetch-site"),
    }, hostedStatus, HOSTED_AI_HANDLERS);
    if (decision.allowed) return NextResponse.next();

    const unavailable = decision.reason === "gemini_unavailable";
    const crossOrigin = decision.reason === "same_origin_required";
    const handlerUnavailable = decision.reason === "hosted_handler_unavailable";
    return NextResponse.json(
      {
        error: unavailable
          ? "Hosted Gemini is not configured."
          : crossOrigin
            ? "This request must come from the same origin."
            : handlerUnavailable
              ? "This hosted AI handler is not enabled in this deployment."
              : "This method is not allowed for this hosted AI endpoint.",
        code: unavailable
          ? "HOSTED_AI_UNAVAILABLE"
          : crossOrigin
            ? "CLOUD_AI_ORIGIN_DENIED"
            : handlerUnavailable
              ? "CLOUD_AI_HANDLER_UNAVAILABLE"
              : "CLOUD_AI_REQUEST_DENIED",
      },
      { status: unavailable ? 503 : crossOrigin ? 403 : handlerUnavailable ? 501 : 405, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (pathname === "/api/run" || pathname.startsWith("/api/explore/ai/")) {
    return NextResponse.json(
      { error: CLOUD_EXECUTION_MESSAGE, code: "CLOUD_EXECUTION_DISABLED" },
      { status: 501, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (pathname.startsWith("/api/") && (!SAFE_CLOUD_API_PATHS.has(pathname) || !["GET", "HEAD"].includes(request.method))) {
    return NextResponse.json(
      { error: CLOUD_EXECUTION_MESSAGE, code: "CLOUD_EXECUTION_DISABLED" },
      { status: 501, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
