import { cloudReadApplications } from "@/lib/cloud-career-ops";
import { authorizePortfolio, getPortfolioStore, portfolioErrorResponse, PortfolioError } from "@/lib/portfolio-cloud.mjs";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(req:Request){
  try {
    authorizePortfolio(req);
    if(Number(req.headers.get("content-length"))>3000) throw new PortfolioError("PORTFOLIO_REQUEST_TOO_LARGE",413);
    if(!req.headers.get("content-type")?.startsWith("application/json")) throw new PortfolioError("PORTFOLIO_JSON_REQUIRED",415);
    const body=await req.json();
    const store=await getPortfolioStore();
    const applications=await cloudReadApplications();
    const result=await store.associate(body?.applicationNumber,body?.portfolioId,body?.version,
      async number=>applications.some(app=>app.n===number));
    return Response.json({result},{headers:{"Cache-Control":"no-store"}});
  } catch(e) { return portfolioErrorResponse(e); }
}
