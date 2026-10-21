import { authorizePortfolio, getPortfolioStore, portfolioErrorResponse } from "@/lib/portfolio-cloud.mjs";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(req:Request) {
  try {
    authorizePortfolio(req);
    const u=new URL(req.url);
    const store=await getPortfolioStore();
    const data=await store.download(u.searchParams.get("portfolioId"),u.searchParams.get("version"));
    return new Response(new Uint8Array(data), {headers:{
      "Content-Type":"application/pdf",
      "Content-Disposition":'attachment; filename="career-ops-portfolio.pdf"',
      "Content-Length":String(data.byteLength),
      "Cache-Control":"private, no-store",
      "X-Content-Type-Options":"nosniff"
    }});
  } catch(e) { return portfolioErrorResponse(e); }
}
