import { NextResponse } from "next/server";
import { cloudHealth } from "@/lib/deployment";

export const dynamic = "force-dynamic";

/** Non-sensitive readiness signal for deployment checks. */
export async function GET() {
  return NextResponse.json(cloudHealth(), {
    headers: { "Cache-Control": "no-store" },
  });
}
