import { authorizePortfolio, getPortfolioStore, portfolioErrorResponse, PortfolioError, MAX_PORTFOLIO_BYTES } from "@/lib/portfolio-cloud.mjs";
export const runtime="nodejs";
export const dynamic="force-dynamic";
function parseArray(v:FormDataEntryValue|null): string[] {
  try {
    const a:unknown=JSON.parse(String(v ?? "[]"));
    if(Array.isArray(a) && a.every(x=>typeof x==="string")) return a;
  } catch { /* invalid */ }
  throw new PortfolioError("PORTFOLIO_ARRAY_INVALID");
}
export async function GET(req:Request) {
  try { authorizePortfolio(req); const store=await getPortfolioStore(); return Response.json(await store.list(),{headers:{"Cache-Control":"no-store"}}); }
  catch(e) { return portfolioErrorResponse(e); }
}
export async function POST(req:Request) {
  try {
    authorizePortfolio(req);
    if(Number(req.headers.get("content-length"))>MAX_PORTFOLIO_BYTES+250_000)
      throw new PortfolioError("PORTFOLIO_REQUEST_TOO_LARGE",413);
    if(!req.headers.get("content-type")?.startsWith("multipart/form-data"))
      throw new PortfolioError("PORTFOLIO_MULTIPART_REQUIRED",415);
    const f=await req.formData();
    const pdf=f.get("file");
    if(!(pdf instanceof File)) throw new PortfolioError("PORTFOLIO_FILE_REQUIRED");
    if(pdf.size>MAX_PORTFOLIO_BYTES) throw new PortfolioError("PORTFOLIO_REQUEST_TOO_LARGE",413);
    if(pdf.type && !["application/pdf","application/octet-stream"].includes(pdf.type))
      throw new PortfolioError("PORTFOLIO_PDF_REQUIRED");
    const store=await getPortfolioStore();
    const result=await store.upload({
      portfolioId: f.get("portfolioId") ? String(f.get("portfolioId")) : undefined,
      title:String(f.get("title")||""),
      kind:String(f.get("kind")||""),
      tags:parseArray(f.get("tags")),projectIds:parseArray(f.get("projectIds"))
    },Buffer.from(await pdf.arrayBuffer()));
    return Response.json({result},{status:201,headers:{"Cache-Control":"no-store"}});
  } catch(e) { return portfolioErrorResponse(e); }
}
