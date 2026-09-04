import { NextRequest, NextResponse } from "next/server";
import { CLOUD_EXECUTION_MESSAGE, isCloudRuntime } from "@/lib/deployment";

const SAFE_CLOUD_API_PATHS = new Set(["/api/health", "/api/version", "/api/pipeline", "/api/cv", "/api/memory", "/api/whats-new", "/api/report/shape"]);

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

  if (request.nextUrl.pathname.startsWith("/api/") && (!SAFE_CLOUD_API_PATHS.has(request.nextUrl.pathname) || !["GET", "HEAD"].includes(request.method))) {
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
