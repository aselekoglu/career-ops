import { cloudReadApplications } from "@/lib/cloud-career-ops";
import { authorizePortfolio, getPortfolioStore, portfolioErrorResponse, PortfolioError, rankPortfolios } from "@/lib/portfolio-cloud.mjs";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(req:Request) {
  try {
    authorizePortfolio(req);
    const url=new URL(req.url);
    if([...url.searchParams.keys()].some(k=>k!=="applicationNumber")) throw new PortfolioError("PORTFOLIO_QUERY_INVALID");
    const number=url.searchParams.get("applicationNumber")||"";
    if(!/^[1-9][0-9]{0,5}$/.test(number)) throw new PortfolioError("PORTFOLIO_APPLICATION_INVALID");
    const apps=await cloudReadApplications();
    const app=apps.find(a=>a.n===number);
    if(!app) throw new PortfolioError("PORTFOLIO_APPLICATION_NOT_FOUND",404);
    const store=await getPortfolioStore();
    const catalog=await store.list();
    return Response.json({application:{n:app.n,company:app.company,role:app.role},
      recommendations:rankPortfolios(catalog.portfolios,app.role)}, {headers:{"Cache-Control":"no-store"}});
  } catch(e) { return portfolioErrorResponse(e); }
}
