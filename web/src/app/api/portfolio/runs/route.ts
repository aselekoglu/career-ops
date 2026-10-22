import {authorizePortfolio,portfolioErrorResponse,PortfolioError} from '@/lib/portfolio-cloud.mjs';
import {handlePortfolioRunRequest} from '@/lib/portfolio-runs.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';export const maxDuration=300;
export async function POST(request:Request){try{authorizePortfolio(request);return await handlePortfolioRunRequest(request)}catch(error){return portfolioErrorResponse(error)}}
export async function GET(request:Request){try{authorizePortfolio(request);throw new PortfolioError('PORTFOLIO_METHOD_NOT_ALLOWED',405)}catch(error){return portfolioErrorResponse(error)}}
