import { handleLiveCoverLetter } from '@/lib/cover-letter-live.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(request: Request) {
  return handleLiveCoverLetter(request);
}
