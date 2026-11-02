import {authorizePortfolio,portfolioErrorResponse,PortfolioError} from '@/lib/portfolio-cloud.mjs';
import {handlePortfolioRunRequest} from '@/lib/portfolio-runs.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';export const maxDuration=300;
export async function POST(request:Request,context:{params:Promise<{id:string;action:string}>}){try{authorizePortfolio(request);const {id,action}=await context.params;if(!['preview','apply','cancel'].includes(action))throw new PortfolioError('PORTFOLIO_ACTION_INVALID',404);return await handlePortfolioRunRequest(request,id,action as 'preview'|'apply'|'cancel')}catch(error){return portfolioErrorResponse(error)}}
