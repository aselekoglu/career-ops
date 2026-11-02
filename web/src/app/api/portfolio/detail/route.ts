import { authorizePortfolio,getPortfolioStore,portfolioErrorResponse,PortfolioError } from "@/lib/portfolio-cloud.mjs";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request:Request) {
  try {
    authorizePortfolio(request);
    const url=new URL(request.url);
    if([...url.searchParams.keys()].some(key=>!['portfolioId','version'].includes(key)))throw new PortfolioError('PORTFOLIO_QUERY_INVALID');
    const id=url.searchParams.get('portfolioId')||'';const version=Number(url.searchParams.get('version'));
    const result=await (await getPortfolioStore()).detail(id,version);
    return Response.json(result,{headers:{'Cache-Control':'no-store'}});
  } catch(error) { return portfolioErrorResponse(error); }
}
