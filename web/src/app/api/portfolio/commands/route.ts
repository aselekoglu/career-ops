import { authorizePortfolio,getPortfolioStore,portfolioErrorResponse,PortfolioError } from "@/lib/portfolio-cloud.mjs";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:Request) {
  try {
    authorizePortfolio(request);
    if(Number(request.headers.get('content-length')||0)>32_000)throw new PortfolioError('PORTFOLIO_REQUEST_TOO_LARGE',413);
    if(!request.headers.get('content-type')?.includes('application/json'))throw new PortfolioError('PORTFOLIO_JSON_REQUIRED',415);
    const input=await request.json();
    const allowed=['operationId','operation','id','expectedRevision','changes','confirm','confirmationName','detachAssociations'];
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!allowed.includes(k)))throw new PortfolioError('PORTFOLIO_COMMAND_INVALID');
    const result=await (await getPortfolioStore()).command(input);
    return Response.json({result},{headers:{'Cache-Control':'no-store'}});
  } catch(error) { return portfolioErrorResponse(error); }
}
