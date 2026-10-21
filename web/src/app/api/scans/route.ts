import { handleScanRequest } from '@/lib/cloud-scans.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
export async function POST(request: Request) { return handleScanRequest(request); }
