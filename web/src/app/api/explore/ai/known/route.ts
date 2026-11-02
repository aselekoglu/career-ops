import { assembleDedupContext } from "@/lib/core/discover";
import { isCloudRuntime } from "@/lib/deployment";
import { cloudDataEnabled, getCloudDocument } from "@/lib/cloud-store";
import { readHostedExploreKnownUrls } from "@/lib/ai/hosted-explore-known.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The client fetches this once before opening the AI stream and uses the set as a
// silent dedup backstop in the envelope parser (drops any AI candidate whose URL
// is already known). Keeps the stream itself pure text/plain.
export async function GET() {
  if (isCloudRuntime()) {
    if (!cloudDataEnabled()) {
      return Response.json({ error: "Known Explore URLs are unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    try {
      // No other Neon content is loaded or sent to Gemini.
      const urls = await readHostedExploreKnownUrls(getCloudDocument);
      return Response.json({ urls }, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return Response.json({ error: "Known Explore URLs are unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  }

  try {
    const { urls } = assembleDedupContext();
    return Response.json({ urls: [...urls] });
  } catch {
    return Response.json({ urls: [] });
  }
}
