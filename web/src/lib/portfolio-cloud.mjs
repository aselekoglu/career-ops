import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

export const MAX_PORTFOLIO_BYTES = 4_000_000; // Vercel Hobby request body limit is ~4.5 MiB.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APP_ID = /^[1-9][0-9]{0,5}$/;
const sha = (b) => createHash("sha256").update(b).digest("hex");

export class PortfolioError extends Error {
  constructor(code, status = 400) { super(code); this.name = "PortfolioError"; this.status = status; }
}

export function authorizePortfolio(request, env = process.env) {
  // Reuse the exact site-owner Basic authentication that guards all hosted
  // Career Ops pages and existing CV artifacts. No second credential to leak
  // into the browser or configure in the ChatGPT Site bridge.
  const user = env.CAREER_OPS_WEB_AUTH_USER;
  const pass = env.CAREER_OPS_WEB_AUTH_PASSWORD;
  if (!user || !pass) throw new PortfolioError("PORTFOLIO_AUTH_NOT_CONFIGURED", 503);
  const header = request.headers.get("authorization") || "";
  if (!header.startsWith("Basic ")) throw new PortfolioError("PORTFOLIO_UNAUTHORIZED", 401);
  const encoded = header.slice(6);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new PortfolioError("PORTFOLIO_UNAUTHORIZED", 401);
  }
  const supplied = Buffer.from(encoded, "base64");
  const expected = Buffer.from(user + ":" + pass, "utf8");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new PortfolioError("PORTFOLIO_UNAUTHORIZED", 401);
  }
  if (!["GET", "HEAD"].includes(request.method)) {
    // Basic Auth is ambient in browsers: block CSRF and cross-origin writes.
    const origin = request.headers.get("origin");
    if (origin) {
      let valid;
      try { valid = new URL(origin).origin === new URL(request.url).origin; }
      catch { valid = false; }
      if (!valid) throw new PortfolioError("PORTFOLIO_CROSS_ORIGIN", 403);
    }
    const site = request.headers.get("sec-fetch-site");
    if (site && !["none", "same-origin"].includes(site)) throw new PortfolioError("PORTFOLIO_CROSS_ORIGIN", 403);
  }
}

export function validatePortfolioPdf(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 100 || bytes.length > MAX_PORTFOLIO_BYTES) {
    throw new PortfolioError("PORTFOLIO_PDF_SIZE_INVALID", 413);
  }
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-" ||
      !bytes.subarray(-2048).toString("latin1").includes("%%EOF")) {
    throw new PortfolioError("PORTFOLIO_PDF_INVALID");
  }
  return { sha256: sha(bytes), byteSize: bytes.length };
}

function boundedText(value, field, max = 160) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw new PortfolioError("PORTFOLIO_" + field + "_INVALID");
  }
  return value.trim();
}
export function parseTags(value) {
  if (!Array.isArray(value) || value.length > 16) throw new PortfolioError("PORTFOLIO_TAGS_INVALID");
  return [...new Set(value.map(v => boundedText(v, "TAG", 56).toLowerCase()))];
}
export function parseProjectIds(value) {
  if (!Array.isArray(value) || value.length > 64 || value.some(v => typeof v !== "string" || !UUID.test(v))) {
    throw new PortfolioError("PORTFOLIO_PROJECT_IDS_INVALID");
  }
  return [...new Set(value)];
}
export function projectInput(value) {
  const name = boundedText(value?.name, "PROJECT_NAME", 120);
  const summary = boundedText(value?.summary, "PROJECT_SUMMARY", 1000);
  let url = "";
  if (value?.url) {
    const raw = boundedText(value.url, "PROJECT_URL", 500);
    let parsed;
    try { parsed = new URL(raw); } catch { throw new PortfolioError("PORTFOLIO_PROJECT_URL_INVALID"); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password)
      throw new PortfolioError("PORTFOLIO_PROJECT_URL_INVALID");
    url = raw;
  }
  return { name, summary, url, tags: parseTags(value?.tags ?? []) };
}
export function rankPortfolios(portfolios, role) {
  const stop = new Set(["the","and","for","with","of","in","at","a","to","on","senior","junior"]);
  const tokenize = x => [...new Set(String(x).toLowerCase().match(/[a-z0-9]+/g)?.filter(t => t.length > 2 && !stop.has(t)) || [])];
  const requested = tokenize(role);
  return portfolios.map(item => {
    const keywords = new Set([...tokenize(item.title), ...(item.tags || []).flatMap(tokenize)]);
    const matchedTerms = requested.filter(t => keywords.has(t));
    return { portfolioId: item.id, title: item.title, kind: item.kind, latestVersion: item.latestVersion,
      score: matchedTerms.length, matchedTerms };
  }).sort((a,b) => b.score-a.score || a.title.localeCompare(b.title));
}

const SCHEMA = [
`CREATE TABLE IF NOT EXISTS career_ops_portfolios (
  id UUID PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('master','variant')),
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  project_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
`CREATE TABLE IF NOT EXISTS career_ops_portfolio_versions (
  portfolio_id UUID NOT NULL REFERENCES career_ops_portfolios(id),
  version INTEGER NOT NULL CHECK(version > 0), document_path TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (portfolio_id, version)
)`,
`CREATE TABLE IF NOT EXISTS career_ops_portfolio_projects (
  id UUID PRIMARY KEY, name TEXT NOT NULL, summary TEXT NOT NULL,
  url TEXT NOT NULL, tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
`CREATE TABLE IF NOT EXISTS career_ops_portfolio_applications (
  application_number TEXT PRIMARY KEY,
  portfolio_id UUID NOT NULL,
  version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (portfolio_id,version) REFERENCES career_ops_portfolio_versions(portfolio_id,version)
)`,
`CREATE INDEX IF NOT EXISTS career_ops_portfolio_versions_created
  ON career_ops_portfolio_versions (created_at DESC)`
];

export function createPortfolioStore(sql) {
  let ready;
  async function initialize() {
    if (!ready) ready = (async () => { for (const ddl of SCHEMA) await sql.query(ddl, []); })().catch(e => { ready = null; throw e; });
    await ready;
  }
  async function list() {
    await initialize();
    const [portfolios, versions, projects, associations] = await Promise.all([
      sql.query("SELECT id,title,kind,tags,project_ids,created_at FROM career_ops_portfolios ORDER BY created_at DESC", []),
      sql.query("SELECT portfolio_id,version,document_path,sha256,byte_size,created_at FROM career_ops_portfolio_versions ORDER BY version DESC", []),
      sql.query("SELECT id,name,summary,url,tags,created_at FROM career_ops_portfolio_projects ORDER BY created_at DESC", []),
      sql.query("SELECT application_number,portfolio_id,version,created_at FROM career_ops_portfolio_applications", []),
    ]);
    return {
      portfolios: portfolios.map(p => ({
        id:p.id, title:p.title,kind:p.kind,tags:p.tags || [],projectIds:p.project_ids || [],
        createdAt:p.created_at,versions:versions.filter(v=>v.portfolio_id===p.id).map(v=>({
          version:v.version,bytes:v.byte_size,sha256:v.sha256,createdAt:v.created_at
        })),latestVersion:versions.find(v=>v.portfolio_id===p.id)?.version || null
      })),
      projects:projects.map(p=>({ id:p.id,name:p.name,summary:p.summary,url:p.url,tags:p.tags,createdAt:p.created_at })),
      associations:associations.map(a=>({ applicationNumber:a.application_number,portfolioId:a.portfolio_id,
        version:a.version,createdAt:a.created_at }))
    };
  }
  async function addProject(input) {
    await initialize();
    const p = projectInput(input);
    const id = randomUUID();
    await sql.query("INSERT INTO career_ops_portfolio_projects(id,name,summary,url,tags) VALUES ($1,$2,$3,$4,$5::jsonb)",
      [id,p.name,p.summary,p.url,JSON.stringify(p.tags)]);
    return {id,...p};
  }
  async function upload(input, bytes) {
    await initialize();
    const meta = validatePortfolioPdf(bytes);
    const id = input.portfolioId || randomUUID();
    if (!UUID.test(id)) throw new PortfolioError("PORTFOLIO_ID_INVALID");
    const updating = Boolean(input.portfolioId);
    const title = updating ? "" : boundedText(input.title, "TITLE");
    const kind = updating ? "" : input.kind;
    if (!updating && !["master","variant"].includes(kind)) throw new PortfolioError("PORTFOLIO_KIND_INVALID");
    const tags = updating ? [] : parseTags(input.tags ?? []);
    const projectIds = updating ? [] : parseProjectIds(input.projectIds ?? []);
    if (projectIds.length) {
      const exists = await sql.query("SELECT id FROM career_ops_portfolio_projects WHERE id = ANY($1::uuid[])", [projectIds]);
      if (exists.length !== projectIds.length) throw new PortfolioError("PORTFOLIO_PROJECT_NOT_FOUND");
    }
    // Immutable, unpredictable content path; never use client filenames for SQL keys.
    const documentPath = "portfolios/" + id + "-" + randomUUID() + ".pdf";
    const args = [id,title,kind,JSON.stringify(tags),JSON.stringify(projectIds),
      documentPath,bytes.toString("base64"),meta.sha256,meta.byteSize];
    const query = updating
      ? `WITH p AS (SELECT id FROM career_ops_portfolios WHERE id=$1 FOR UPDATE),
          next_version AS (
            SELECT (COALESCE(MAX(v.version),0)+1)::int AS n FROM career_ops_portfolio_versions v,p
            WHERE v.portfolio_id=p.id
          ),
          doc AS (
            INSERT INTO career_ops_documents(path,content,sha256,content_encoding,byte_size,updated_at)
            SELECT $6,$7,$8,'base64',$9,now() FROM p RETURNING path
          ),
          v AS (
            INSERT INTO career_ops_portfolio_versions(portfolio_id,version,document_path,sha256,byte_size)
            SELECT p.id,n.n,doc.path,$8,$9 FROM p,next_version n,doc
            RETURNING version
          ) SELECT version FROM v`
      : `WITH p AS (
            INSERT INTO career_ops_portfolios(id,title,kind,tags,project_ids)
            VALUES($1,$2,$3,$4::jsonb,$5::jsonb) RETURNING id
          ), doc AS (
            INSERT INTO career_ops_documents(path,content,sha256,content_encoding,byte_size,updated_at)
            SELECT $6,$7,$8,'base64',$9,now() FROM p RETURNING path
          ), v AS (
            INSERT INTO career_ops_portfolio_versions(portfolio_id,version,document_path,sha256,byte_size)
            SELECT p.id,1,doc.path,$8,$9 FROM p,doc RETURNING version
          ) SELECT version FROM v`;
    const rows = await sql.query(query,args);
    if (!rows[0]) throw new PortfolioError("PORTFOLIO_NOT_FOUND",404);
    return { portfolioId:id, version:Number(rows[0].version),sha256:meta.sha256,byteSize:meta.byteSize };
  }
  async function download(id,version) {
    await initialize();
    if (!UUID.test(String(id || "")) || !Number.isSafeInteger(Number(version)) || Number(version) < 1)
      throw new PortfolioError("PORTFOLIO_VERSION_INVALID");
    const rows = await sql.query(`SELECT d.content,d.sha256,d.byte_size,d.content_encoding
      FROM career_ops_portfolio_versions v JOIN career_ops_documents d ON d.path=v.document_path
      WHERE v.portfolio_id=$1 AND v.version=$2 LIMIT 1`,[id,Number(version)]);
    const row = rows[0];
    if (!row) throw new PortfolioError("PORTFOLIO_NOT_FOUND",404);
    if (row.content_encoding !== "base64" || typeof row.content !== "string" ||
      row.content.length > Math.ceil(MAX_PORTFOLIO_BYTES/3)*4+4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.content)) {
      throw new PortfolioError("PORTFOLIO_PDF_CORRUPT",500);
    }
    const data=Buffer.from(row.content,"base64");
    const proof=validatePortfolioPdf(data);
    if (data.toString("base64") !== row.content || Number(row.byte_size)!==data.length || proof.sha256!==row.sha256) {
      throw new PortfolioError("PORTFOLIO_PDF_CORRUPT",500);
    }
    return data;
  }
  async function associate(applicationNumber,id,version,applicationExists) {
    await initialize();
    const num=String(applicationNumber||"");
    if (!APP_ID.test(num) || !(await applicationExists(num))) throw new PortfolioError("PORTFOLIO_APPLICATION_NOT_FOUND",404);
    if (!UUID.test(String(id||"")) || !Number.isSafeInteger(Number(version)) || Number(version)<1)
      throw new PortfolioError("PORTFOLIO_VERSION_INVALID");
    const rows=await sql.query(`INSERT INTO career_ops_portfolio_applications(application_number,portfolio_id,version)
      SELECT $1,v.portfolio_id,v.version FROM career_ops_portfolio_versions v
      WHERE v.portfolio_id=$2 AND v.version=$3
      ON CONFLICT(application_number) DO UPDATE SET
       portfolio_id=EXCLUDED.portfolio_id,version=EXCLUDED.version,created_at=now()
      RETURNING application_number,portfolio_id,version`,[num,id,Number(version)]);
    if (!rows[0]) throw new PortfolioError("PORTFOLIO_NOT_FOUND",404);
    return {applicationNumber:num,portfolioId:id,version:Number(version)};
  }
  return { initialize,list,addProject,upload,download,associate };
}

let shared;
export async function getPortfolioStore() {
  if (!process.env.DATABASE_URL) throw new PortfolioError("PORTFOLIO_STORE_UNAVAILABLE",503);
  if (!shared) {
    shared = import("@neondatabase/serverless").then(({neon}) => createPortfolioStore(neon(process.env.DATABASE_URL)));
  }
  return shared;
}

export function portfolioErrorResponse(error) {
  const allowed = error instanceof PortfolioError;
  return Response.json({code:allowed?error.message:"PORTFOLIO_INTERNAL_ERROR"},
    {status:allowed?error.status:503,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
}
