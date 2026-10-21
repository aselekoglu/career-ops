export const MAX_PORTFOLIO_BYTES: number;
export class PortfolioError extends Error {
  status: number;
  constructor(code: string, status?: number);
}
export function authorizePortfolio(request: Request, env?: NodeJS.ProcessEnv): void;
export function validatePortfolioPdf(bytes: Buffer): {sha256:string;byteSize:number};
export function parseTags(tags: unknown): string[];
export function parseProjectIds(projectIds: unknown): string[];
export function projectInput(input: unknown): {name:string;summary:string;url:string;tags:string[]};
export function rankPortfolios(portfolios: Array<{id:string;title:string;kind:string;tags:string[];latestVersion:number|null}>,role:string):
  Array<{portfolioId:string;title:string;kind:string;latestVersion:number|null;score:number;matchedTerms:string[]}>;
export function createPortfolioStore(sql: {query(query:string,args:any[]): Promise<any[]>}): {
  initialize():Promise<void>;
  list():Promise<any>;
  addProject(input:any):Promise<any>;
  upload(input:any,bytes:Buffer):Promise<any>;
  download(id:any,version:any):Promise<Buffer>;
  associate(applicationNumber:any,id:any,version:any,applicationExists:(id:string)=>Promise<boolean>):Promise<any>;
};
export function getPortfolioStore():Promise<ReturnType<typeof createPortfolioStore>>;
export function portfolioErrorResponse(error:unknown): Response;
