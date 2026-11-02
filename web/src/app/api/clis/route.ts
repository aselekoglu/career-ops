import { NextResponse } from "next/server";
import { detectClis } from "@/lib/clis";
import { isCloudRuntime } from "@/lib/deployment";

export const dynamic = "force-dynamic";

// Detects which agnostic CLIs are installed on THIS machine (local-first). The
// web delegates career-ops to one of these in headless mode, on the user's own
// auth/tokens — no API key needed.
export async function GET() {
  if (isCloudRuntime()) {
    return NextResponse.json({
      clis: [],
      cloud: true,
      message: "AI CLIs installed on your computer are not available inside the Vercel deployment.",
    }, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ clis: detectClis() });
}
