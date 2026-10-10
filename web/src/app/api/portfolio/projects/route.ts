import { authorizePortfolio, getPortfolioStore, portfolioErrorResponse, PortfolioError } from "@/lib/portfolio-cloud.mjs";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(req:Request){
  try {
    authorizePortfolio(req);
    if(Number(req.headers.get("content-length"))>6000) throw new PortfolioError("PORTFOLIO_REQUEST_TOO_LARGE",413);
    if(!req.headers.get("content-type")?.startsWith("application/json")) throw new PortfolioError("PORTFOLIO_JSON_REQUIRED",415);
    const store=await getPortfolioStore();
    const result=await store.addProject(await req.json());
    return Response.json({result},{status:201,headers:{"Cache-Control":"no-store"}});
  } catch(e) { return portfolioErrorResponse(e); }
}
