import {authorizePortfolio,portfolioErrorResponse,PortfolioError} from '@/lib/portfolio-cloud.mjs';
import {handlePortfolioRunRequest} from '@/lib/portfolio-runs.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(request:Request,context:{params:Promise<{id:string}>}){try{authorizePortfolio(request);const {id}=await context.params;return await handlePortfolioRunRequest(request,id)}catch(error){return portfolioErrorResponse(error)}}
export async function POST(request:Request){try{authorizePortfolio(request);throw new PortfolioError('PORTFOLIO_ACTION_REQUIRED')}catch(error){return portfolioErrorResponse(error)}}
