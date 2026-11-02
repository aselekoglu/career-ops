import { handleCloudSourceRead } from "@/lib/cloud-source-management.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ source: string }> };

export async function GET(_request: Request, { params }: Context) {
  const { source } = await params;
  return handleCloudSourceRead(source);
}
