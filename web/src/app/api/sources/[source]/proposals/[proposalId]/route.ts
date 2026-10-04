import { handleCloudSourceProposalRead } from "@/lib/cloud-source-management.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ source: string; proposalId: string }> };

export async function GET(_request: Request, { params }: Context) {
  const { source, proposalId } = await params;
  return handleCloudSourceProposalRead(source, proposalId);
}
