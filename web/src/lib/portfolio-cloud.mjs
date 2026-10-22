import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { normalizePortfolioDocument, MAX_PORTFOLIO_DOCUMENT_BYTES, PortfolioDocumentError } from "./portfolio-document.mjs";

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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), revision INTEGER NOT NULL DEFAULT 1,
  archived_at TIMESTAMPTZ, create_operation_id UUID
)`,
`CREATE TABLE IF NOT EXISTS career_ops_portfolio_versions (
  portfolio_id UUID NOT NULL REFERENCES career_ops_portfolios(id),
  version INTEGER NOT NULL CHECK(version > 0), document_path TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL,
  document_json JSONB, run_id UUID UNIQUE, operation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (portfolio_id, version)
)`,
`CREATE TABLE IF NOT EXISTS career_ops_portfolio_projects (
  id UUID PRIMARY KEY, name TEXT NOT NULL, summary TEXT NOT NULL,
  url TEXT NOT NULL, tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), revision INTEGER NOT NULL DEFAULT 1,
  archived_at TIMESTAMPTZ, operation_id UUID
)`,
`CREATE TABLE IF NOT EXISTS career_ops_portfolio_applications (
  application_number TEXT PRIMARY KEY,
  portfolio_id UUID NOT NULL,
  version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (portfolio_id,version) REFERENCES career_ops_portfolio_versions(portfolio_id,version)
)`,
`CREATE INDEX IF NOT EXISTS career_ops_portfolio_versions_created
  ON career_ops_portfolio_versions (created_at DESC)`,
`ALTER TABLE career_ops_portfolios ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1`,
`ALTER TABLE career_ops_portfolios ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`,
`ALTER TABLE career_ops_portfolios ADD COLUMN IF NOT EXISTS create_operation_id UUID`,
`CREATE UNIQUE INDEX IF NOT EXISTS career_ops_portfolios_create_operation ON career_ops_portfolios(create_operation_id) WHERE create_operation_id IS NOT NULL`,
`ALTER TABLE career_ops_portfolio_versions ADD COLUMN IF NOT EXISTS document_json JSONB`,
`ALTER TABLE career_ops_portfolio_versions ADD COLUMN IF NOT EXISTS run_id UUID`,
`ALTER TABLE career_ops_portfolio_versions ADD COLUMN IF NOT EXISTS operation_id UUID`,
`CREATE UNIQUE INDEX IF NOT EXISTS career_ops_portfolio_versions_run_id ON career_ops_portfolio_versions(run_id) WHERE run_id IS NOT NULL`,
`CREATE UNIQUE INDEX IF NOT EXISTS career_ops_portfolio_versions_operation_id ON career_ops_portfolio_versions(operation_id) WHERE operation_id IS NOT NULL`,
`ALTER TABLE career_ops_portfolio_projects ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1`,
`ALTER TABLE career_ops_portfolio_projects ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`,
`ALTER TABLE career_ops_portfolio_projects ADD COLUMN IF NOT EXISTS operation_id UUID`,
`CREATE UNIQUE INDEX IF NOT EXISTS career_ops_portfolio_projects_operation ON career_ops_portfolio_projects(operation_id) WHERE operation_id IS NOT NULL`,
`CREATE TABLE IF NOT EXISTS career_ops_portfolio_operations (
  operation_id UUID PRIMARY KEY, payload_sha256 TEXT NOT NULL, result JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
`CREATE TABLE IF NOT EXISTS career_ops_portfolio_run_operations (
 operation_id UUID PRIMARY KEY, payload_sha256 TEXT NOT NULL, result JSONB, target_run_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
`ALTER TABLE career_ops_portfolio_run_operations ADD COLUMN IF NOT EXISTS target_run_id UUID`,
`CREATE TABLE IF NOT EXISTS career_ops_portfolio_claim_decisions (
 fingerprint TEXT PRIMARY KEY, claim_text TEXT NOT NULL, outcome TEXT NOT NULL, provenance JSONB NOT NULL, decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
`CREATE TABLE IF NOT EXISTS career_ops_portfolio_runs (
 id UUID PRIMARY KEY, operation_id UUID NOT NULL UNIQUE, state TEXT NOT NULL, phase TEXT NOT NULL, request JSONB NOT NULL,
 portfolio_id UUID, expected_revision INTEGER, source_version INTEGER, source_revision INTEGER, source_sha256 TEXT, source_hashes JSONB NOT NULL DEFAULT '{}'::jsonb,
 document_json JSONB, draft_sha256 TEXT, source_review JSONB, fact_preview JSONB, action_receipt JSONB, format TEXT NOT NULL, lease UUID, lease_expires_at TIMESTAMPTZ,
 pdf_path TEXT, pdf_sha256 TEXT, pdf_byte_size INTEGER, error_code TEXT, requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, canceled_at TIMESTAMPTZ, version INTEGER
 )`,
`ALTER TABLE career_ops_portfolio_runs ADD COLUMN IF NOT EXISTS source_review JSONB`,
`ALTER TABLE career_ops_portfolio_runs ADD COLUMN IF NOT EXISTS fact_preview JSONB`,
`ALTER TABLE career_ops_portfolio_runs ADD COLUMN IF NOT EXISTS action_receipt JSONB`,
`ALTER TABLE career_ops_portfolio_runs ADD COLUMN IF NOT EXISTS source_revision INTEGER`,
`ALTER TABLE career_ops_portfolio_runs ADD COLUMN IF NOT EXISTS version INTEGER`
];

export function createPortfolioStore(sql) {
  let ready;
  async function initialize() {
    if (!ready) ready = (async () => { for (const ddl of SCHEMA) await sql.query(ddl, []); })().catch(e => { ready = null; throw e; });
    await ready;
  }
  async function list({includeArchived=false}={}) {
    await initialize();
    const [portfolios, versions, projects, associations, runs, allPortfolioProjects] = await Promise.all([
      sql.query(`SELECT id,title,kind,tags,project_ids,created_at,revision,archived_at FROM career_ops_portfolios ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY created_at DESC`, []),
      sql.query("SELECT portfolio_id,version,document_path,sha256,byte_size,created_at,document_json FROM career_ops_portfolio_versions ORDER BY version DESC", []),
      sql.query(`SELECT id,name,summary,url,tags,created_at,revision,archived_at FROM career_ops_portfolio_projects ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY created_at DESC`, []),
      sql.query("SELECT application_number,portfolio_id,version,created_at FROM career_ops_portfolio_applications", []),
      sql.query("SELECT id,state,phase,request,portfolio_id,expected_revision,source_version,source_revision,source_sha256,source_hashes,draft_sha256,source_review,fact_preview,format,requested_at,started_at,completed_at,error_code,version FROM career_ops_portfolio_runs ORDER BY requested_at DESC LIMIT 50", []),
      sql.query("SELECT project_ids FROM career_ops_portfolios", []),
    ]);
    return {
      portfolios: portfolios.map(p => ({
        id:p.id, title:p.title,kind:p.kind,tags:p.tags || [],projectIds:p.project_ids || [],
        createdAt:p.created_at,revision:Number(p.revision||1),archivedAt:p.archived_at||null,associationCount:associations.filter(a=>a.portfolio_id===p.id).length,versions:versions.filter(v=>v.portfolio_id===p.id).map(v=>({
          version:v.version,bytes:v.byte_size,sha256:v.sha256,createdAt:v.created_at,hasEditableContent:Boolean(v.document_json)
        })),latestVersion:versions.find(v=>v.portfolio_id===p.id)?.version || null
      })),
      projects:projects.map(p=>({ id:p.id,name:p.name,summary:p.summary,url:p.url,tags:p.tags,createdAt:p.created_at,revision:Number(p.revision||1),archivedAt:p.archived_at||null,usageCount:allPortfolioProjects.filter(f=>(f.project_ids||[]).includes(p.id)).length })),
      associations:associations.map(a=>({ applicationNumber:a.application_number,portfolioId:a.portfolio_id,
        version:a.version,createdAt:a.created_at })),
      runs:runs.map(row=>{const request=typeof row.request==='string'?(()=>{try{return JSON.parse(row.request)}catch{return {}}})():row.request||{};return {
        runId:row.id,status:row.state,phase:row.phase,portfolioId:row.portfolio_id||null,title:request.title||null,mode:request.mode||null,sourceMode:request.sourceMode||'profile',
        tags:Array.isArray(request.tags)?request.tags.slice(0,16):[],projectIds:Array.isArray(request.projectIds)?request.projectIds.slice(0,64):[],
        expectedRevision:Number(row.expected_revision||0),sourceRevision:row.source_revision==null?null:Number(row.source_revision),sourceVersion:row.source_version==null?null:Number(row.source_version),sourceSha256:row.source_sha256||null,
        sourceHashes:row.source_hashes||{},draftSha256:row.state==='awaiting_review'?row.draft_sha256:null,
        sourceReview:row.state==='awaiting_review'?{claims:Array.isArray(row.source_review)?row.source_review.slice(0,80):[],factsReview:row.fact_preview?.factsReview||null}:undefined,
        format:row.format,version:row.state==='completed'?Number(row.version||0):null,
        requestedAt:row.requested_at,startedAt:row.started_at||null,completedAt:row.completed_at||null,errorCode:row.error_code||null
      }})
    };
  }
  async function addProject(input) {
    await initialize();
    const p = projectInput(input);
    const operationId=input?.operationId;
    if(operationId!==undefined&&!UUID.test(String(operationId)))throw new PortfolioError("PORTFOLIO_OPERATION_INVALID");
    if(!operationId){const id=randomUUID();await sql.query("INSERT INTO career_ops_portfolio_projects(id,name,summary,url,tags) VALUES ($1,$2,$3,$4,$5::jsonb)",[id,p.name,p.summary,p.url,JSON.stringify(p.tags)]);return {id,...p}}
    const operationPayload={operation:'add-project',project:p};const payloadHash=sha(Buffer.from(JSON.stringify(operationPayload)));
    const prior=await sql.query("SELECT payload_sha256,result FROM career_ops_portfolio_operations WHERE operation_id=$1",[operationId]);
    if(prior[0]){if(prior[0].payload_sha256!==payloadHash)throw new PortfolioError("PORTFOLIO_OPERATION_REPLAY_MISMATCH",409);if(prior[0].result)return prior[0].result;}
    else await sql.query("INSERT INTO career_ops_portfolio_operations(operation_id,payload_sha256) VALUES($1,$2) ON CONFLICT DO NOTHING",[operationId,payloadHash]);
    const id=randomUUID();
    const rows=await sql.query(`INSERT INTO career_ops_portfolio_projects(id,name,summary,url,tags,operation_id) VALUES($1,$2,$3,$4,$5::jsonb,$6)
      ON CONFLICT(operation_id) DO UPDATE SET operation_id=EXCLUDED.operation_id RETURNING id,name,summary,url,tags`,[id,p.name,p.summary,p.url,JSON.stringify(p.tags),operationId]);
    const result={...rows[0],...(rows[0]?.tags?{}:{tags:p.tags})};
    await sql.query("UPDATE career_ops_portfolio_operations SET result=$2::jsonb WHERE operation_id=$1 AND payload_sha256=$3",[operationId,JSON.stringify(result),payloadHash]);
    return result;
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
    const operationId=input.operationId;
    if(operationId!==undefined&&!UUID.test(String(operationId)))throw new PortfolioError("PORTFOLIO_OPERATION_INVALID");
    if(updating&&input.expectedRevision!==undefined&&(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1))throw new PortfolioError("PORTFOLIO_REVISION_INVALID");
    if (projectIds.length) {
      const exists = await sql.query("SELECT id FROM career_ops_portfolio_projects WHERE id = ANY($1::uuid[])", [projectIds]);
      if (exists.length !== projectIds.length) throw new PortfolioError("PORTFOLIO_PROJECT_NOT_FOUND");
    }
    const operationPayload={operation:'upload',portfolioId:updating?id:null,title,kind,tags,projectIds,expectedRevision:input.expectedRevision??null,sha256:meta.sha256,byteSize:meta.byteSize};
    const payloadHash=operationId?sha(Buffer.from(JSON.stringify(operationPayload))):null;
    if(operationId){
      const prior=await sql.query("SELECT payload_sha256,result FROM career_ops_portfolio_operations WHERE operation_id=$1",[operationId]);
      if(prior[0]){if(prior[0].payload_sha256!==payloadHash)throw new PortfolioError("PORTFOLIO_OPERATION_REPLAY_MISMATCH",409);if(prior[0].result)return prior[0].result;}
      else await sql.query("INSERT INTO career_ops_portfolio_operations(operation_id,payload_sha256) VALUES($1,$2) ON CONFLICT DO NOTHING",[operationId,payloadHash]);
    }
    // Immutable, unpredictable content path; never use client filenames for SQL keys.
    const documentPath = "portfolios/" + id + "-" + randomUUID() + ".pdf";
    const args = [id,title,kind,JSON.stringify(tags),JSON.stringify(projectIds),
      documentPath,bytes.toString("base64"),meta.sha256,meta.byteSize,operationId||null];
    if(updating)args.push(input.expectedRevision??null);
    const query = updating
      ? `WITH existing AS (SELECT portfolio_id,version,sha256,byte_size FROM career_ops_portfolio_versions WHERE operation_id=$10),
          p AS (UPDATE career_ops_portfolios SET revision=revision+1 WHERE id=$1 AND archived_at IS NULL AND ($11::int IS NULL OR revision=$11) AND NOT EXISTS(SELECT 1 FROM existing) RETURNING id),
          next_version AS (
            SELECT (COALESCE(MAX(v.version),0)+1)::int AS n FROM career_ops_portfolio_versions v,p
            WHERE v.portfolio_id=p.id
          ),
          doc AS (
            INSERT INTO career_ops_documents(path,content,sha256,content_encoding,byte_size,updated_at)
            SELECT $6,$7,$8,'base64',$9,now() FROM p RETURNING path
          ),
          v AS (
            INSERT INTO career_ops_portfolio_versions(portfolio_id,version,document_path,sha256,byte_size,operation_id)
            SELECT p.id,n.n,doc.path,$8,$9,$10 FROM p,next_version n,doc
            ON CONFLICT(operation_id) WHERE operation_id IS NOT NULL DO NOTHING RETURNING portfolio_id,version,sha256,byte_size
          ) SELECT portfolio_id,version,sha256,byte_size FROM v UNION ALL SELECT portfolio_id,version,sha256,byte_size FROM existing`
      : `WITH existing AS (SELECT p.id AS portfolio_id,v.version,v.sha256,v.byte_size FROM career_ops_portfolios p JOIN career_ops_portfolio_versions v ON v.portfolio_id=p.id WHERE p.create_operation_id=$10),
          p AS (
            INSERT INTO career_ops_portfolios(id,title,kind,tags,project_ids,create_operation_id)
            VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$10) ON CONFLICT(create_operation_id) WHERE create_operation_id IS NOT NULL DO NOTHING RETURNING id
          ), doc AS (
            INSERT INTO career_ops_documents(path,content,sha256,content_encoding,byte_size,updated_at)
            SELECT $6,$7,$8,'base64',$9,now() FROM p RETURNING path
          ), v AS (
            INSERT INTO career_ops_portfolio_versions(portfolio_id,version,document_path,sha256,byte_size,operation_id)
            SELECT p.id,1,doc.path,$8,$9,$10 FROM p,doc ON CONFLICT(operation_id) WHERE operation_id IS NOT NULL DO NOTHING RETURNING portfolio_id,version,sha256,byte_size
          ) SELECT portfolio_id,version,sha256,byte_size FROM v UNION ALL SELECT portfolio_id,version,sha256,byte_size FROM existing`;
    const rows = await sql.query(query,args);
    if (!rows[0]) throw new PortfolioError(updating&&input.expectedRevision!==undefined?"PORTFOLIO_STALE_REVISION":"PORTFOLIO_NOT_FOUND",updating?409:404);
    const result={ portfolioId:rows[0].portfolio_id||id, version:Number(rows[0].version),sha256:rows[0].sha256||meta.sha256,byteSize:Number(rows[0].byte_size||meta.byteSize) };
    if(operationId)await sql.query("UPDATE career_ops_portfolio_operations SET result=$2::jsonb WHERE operation_id=$1 AND payload_sha256=$3",[operationId,JSON.stringify(result),payloadHash]);
    return result;
  }
  async function detail(id, version) {
    await initialize();
    if (!UUID.test(String(id || "")) || !Number.isSafeInteger(Number(version)) || Number(version) < 1) throw new PortfolioError("PORTFOLIO_VERSION_INVALID");
    const rows = await sql.query(`SELECT p.id,p.title,p.kind,p.tags,p.project_ids,p.revision,p.archived_at,
      v.version,v.document_path,v.sha256,v.byte_size,v.created_at,v.document_json
      FROM career_ops_portfolios p JOIN career_ops_portfolio_versions v ON v.portfolio_id=p.id
      WHERE p.id=$1 AND v.version=$2 LIMIT 1`, [id, Number(version)]);
    if (!rows[0]) throw new PortfolioError("PORTFOLIO_NOT_FOUND",404);
    const row=rows[0];
    return {portfolio:{id:row.id,title:row.title,kind:row.kind,tags:row.tags||[],projectIds:row.project_ids||[],revision:Number(row.revision||1),archivedAt:row.archived_at||null},
      version:{version:Number(row.version),bytes:Number(row.byte_size),sha256:row.sha256,createdAt:row.created_at,hasEditableContent:Boolean(row.document_json)},
      document:row.document_json ? normalizePortfolioDocument(row.document_json) : null};
  }
  async function command(input) {
    await initialize();
    const {operationId,operation,id,expectedRevision,changes={}}=input||{};
    if(!UUID.test(String(operationId||""))||!UUID.test(String(id||""))) throw new PortfolioError("PORTFOLIO_OPERATION_INVALID");
    const allowed=new Set(["update-metadata","archive","restore","purge","update-project","archive-project","restore-project","purge-project"]);
    if(!allowed.has(operation)) throw new PortfolioError("PORTFOLIO_OPERATION_INVALID");
    const payload={operation,id,expectedRevision,changes,confirm:input.confirm===true,confirmationName:input.confirmationName||null,detachAssociations:input.detachAssociations===true};
    const payloadHash=sha(Buffer.from(JSON.stringify(payload)));
    const prior=await sql.query("SELECT payload_sha256,result FROM career_ops_portfolio_operations WHERE operation_id=$1",[operationId]);
    if(prior[0]) {
      if(prior[0].payload_sha256!==payloadHash) throw new PortfolioError("PORTFOLIO_OPERATION_REPLAY_MISMATCH",409);
      if(prior[0].result) { if(prior[0].result.error) throw new PortfolioError(prior[0].result.error,409); return prior[0].result; }
    } else {
      const claimed=await sql.query("INSERT INTO career_ops_portfolio_operations(operation_id,payload_sha256) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING operation_id",[operationId,payloadHash]);
      if(!claimed[0]) {
        const replay=await sql.query("SELECT payload_sha256,result FROM career_ops_portfolio_operations WHERE operation_id=$1",[operationId]);
        if(replay[0]?.payload_sha256!==payloadHash) throw new PortfolioError("PORTFOLIO_OPERATION_REPLAY_MISMATCH",409);
        if(replay[0]?.result) { if(replay[0].result.error) throw new PortfolioError(replay[0].result.error,409); return replay[0].result; }
      }
    }
    return operation.endsWith("project")
      ? projectCommand(id,operation,expectedRevision,input,operationId,payloadHash)
      : portfolioCommand(id,operation,expectedRevision,changes,input,operationId,payloadHash);
  }
  async function portfolioCommand(id,operation,revision,changes,input,operationId,payloadHash) {
    const rows=await sql.query("SELECT id,title,kind,tags,project_ids,revision,archived_at FROM career_ops_portfolios WHERE id=$1",[id]);
    const p=rows[0]; if(!p) throw new PortfolioError("PORTFOLIO_NOT_FOUND",404);
    if(Number(p.revision)!==Number(revision)) throw new PortfolioError("PORTFOLIO_STALE_REVISION",409);
    if(operation==="update-metadata") {
      const keys=Object.keys(changes||{}); if(keys.some(k=>!['title','kind','tags','projectIds'].includes(k))) throw new PortfolioError("PORTFOLIO_METADATA_INVALID");
      const title=changes.title===undefined?p.title:boundedText(changes.title,"TITLE");
      const kind=changes.kind===undefined?p.kind:changes.kind; if(!['master','variant'].includes(kind)) throw new PortfolioError("PORTFOLIO_KIND_INVALID");
      const tags=changes.tags===undefined?(p.tags||[]):parseTags(changes.tags);
      const ids=changes.projectIds===undefined?(p.project_ids||[]):parseProjectIds(changes.projectIds);
      if(ids.length){const exists=await sql.query("SELECT id FROM career_ops_portfolio_projects WHERE id=ANY($1::uuid[]) AND archived_at IS NULL",[ids]);if(exists.length!==ids.length)throw new PortfolioError("PORTFOLIO_PROJECT_NOT_FOUND");}
      const updated=await sql.query(`WITH changed AS (UPDATE career_ops_portfolios p SET title=$2,kind=$3,tags=$4::jsonb,project_ids=$5::jsonb,revision=revision+1 WHERE id=$1 AND revision=$6 AND archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements($5::jsonb) x WHERE NOT EXISTS(SELECT 1 FROM career_ops_portfolio_projects pr WHERE pr.id=(x#>>'{}')::uuid AND pr.archived_at IS NULL)) RETURNING p.*),
        saved AS (UPDATE career_ops_portfolio_operations o SET result=to_jsonb(changed) FROM changed WHERE o.operation_id=$7 AND o.payload_sha256=$8 RETURNING o.result) SELECT result FROM saved`,[id,title,kind,JSON.stringify(tags),JSON.stringify(ids),revision,operationId,payloadHash]);
      if(!updated[0])throw new PortfolioError("PORTFOLIO_STALE_REVISION",409); return updated[0].result;
    }
    if(operation==="archive"||operation==="restore") {
      if(input.confirm!==true)throw new PortfolioError("PORTFOLIO_CONFIRMATION_REQUIRED");
      const archived=operation==="archive";
      if(archived){const active=await sql.query("SELECT id FROM career_ops_portfolio_runs WHERE portfolio_id=$1 AND state IN ('queued','running','awaiting_review')",[id]);if(active.length)throw new PortfolioError("PORTFOLIO_ACTIVE_RUNS_REQUIRE_RESOLUTION",409)}
      const updated=await sql.query(`WITH changed AS (UPDATE career_ops_portfolios p SET archived_at=$2,revision=revision+1 WHERE id=$1 AND revision=$3 AND (($4::boolean AND archived_at IS NULL) OR (NOT $4::boolean AND archived_at IS NOT NULL)) AND (NOT $4::boolean OR NOT EXISTS(SELECT 1 FROM career_ops_portfolio_runs r WHERE r.portfolio_id=p.id AND r.state IN ('queued','running','awaiting_review'))) RETURNING p.*),
        saved AS (UPDATE career_ops_portfolio_operations o SET result=to_jsonb(changed) FROM changed WHERE o.operation_id=$5 AND o.payload_sha256=$6 RETURNING o.result) SELECT result FROM saved`,[id,archived?new Date().toISOString():null,revision,archived,operationId,payloadHash]);
      if(!updated[0])throw new PortfolioError("PORTFOLIO_STALE_REVISION",409);return updated[0].result;
    }
    if(operation==="purge") {
      if(input.confirm!==true||p.archived_at==null||input.confirmationName!==p.title)throw new PortfolioError("PORTFOLIO_PURGE_CONFIRMATION_INVALID",409);
      const associations=await sql.query("SELECT application_number FROM career_ops_portfolio_applications WHERE portfolio_id=$1",[id]);
      if(associations.length&&!input.detachAssociations)throw new PortfolioError("PORTFOLIO_ASSOCIATIONS_REQUIRE_CONFIRMATION",409);
      const purged=await sql.query(`WITH eligible AS (SELECT p.id FROM career_ops_portfolios p WHERE p.id=$1 AND p.revision=$2 AND p.archived_at IS NOT NULL AND p.title=$3
          AND NOT EXISTS(SELECT 1 FROM career_ops_portfolio_runs r WHERE (r.portfolio_id=p.id OR r.request->>'basePortfolioId'=p.id::text) AND r.state IN ('queued','running','awaiting_review'))
          AND ($6::boolean OR NOT EXISTS(SELECT 1 FROM career_ops_portfolio_applications a WHERE a.portfolio_id=p.id)) FOR UPDATE),
        unlinked AS (DELETE FROM career_ops_portfolio_applications a USING eligible e WHERE a.portfolio_id=e.id RETURNING a.application_number),
        versions AS (DELETE FROM career_ops_portfolio_versions v USING eligible e WHERE v.portfolio_id=e.id RETURNING v.document_path),
        documents AS (DELETE FROM career_ops_documents d USING versions v WHERE d.path=v.document_path RETURNING d.path),
        run_payloads AS (DELETE FROM career_ops_portfolio_runs r USING eligible e WHERE r.portfolio_id=e.id RETURNING r.id,r.operation_id),
        run_ops AS (DELETE FROM career_ops_portfolio_run_operations o USING run_payloads r WHERE o.operation_id=r.operation_id OR o.target_run_id=r.id RETURNING o.operation_id),
        dependent_runs AS (UPDATE career_ops_portfolio_runs r SET request=r.request-'basePortfolioId',source_version=NULL,source_sha256=NULL,source_hashes='{}'::jsonb,source_review=NULL,fact_preview=NULL
          FROM eligible e WHERE r.portfolio_id<>e.id AND r.request->>'basePortfolioId'=e.id::text RETURNING r.id),
        markers AS (DELETE FROM career_ops_portfolio_claim_decisions d USING eligible e WHERE d.provenance->>'portfolioId'=e.id::text RETURNING d.fingerprint),
        scrubbed AS (UPDATE career_ops_portfolio_operations o SET result=jsonb_build_object('purged',true)
          WHERE o.operation_id<>$4 AND (o.result->>'id'=$1::text OR o.result->>'portfolioId'=$1::text) RETURNING o.operation_id),
        removed AS (DELETE FROM career_ops_portfolios p USING eligible e WHERE p.id=e.id AND (SELECT COUNT(*) FROM versions)>=0 AND (SELECT COUNT(*) FROM run_payloads)>=0 AND (SELECT COUNT(*) FROM dependent_runs)>=0 AND (SELECT COUNT(*) FROM markers)>=0 AND (SELECT COUNT(*) FROM scrubbed)>=0 RETURNING p.id),
        saved AS (UPDATE career_ops_portfolio_operations o SET result=jsonb_build_object('id',$1::text,'purged',true) FROM removed WHERE o.operation_id=$4 AND o.payload_sha256=$5 RETURNING o.result)
        SELECT result FROM saved`,[id,revision,input.confirmationName,operationId,payloadHash,input.detachAssociations===true]);
      if(!purged[0])throw new PortfolioError("PORTFOLIO_PURGE_CONFLICT",409);return purged[0].result;
    }
    throw new PortfolioError("PORTFOLIO_OPERATION_INVALID");
  }
  async function projectCommand(id,operation,revision,input,operationId,payloadHash) {
    const rows=await sql.query("SELECT id,name,summary,url,tags,revision,archived_at FROM career_ops_portfolio_projects WHERE id=$1",[id]);
    const p=rows[0];if(!p)throw new PortfolioError("PORTFOLIO_PROJECT_NOT_FOUND",404);
    if(Number(p.revision)!==Number(revision))throw new PortfolioError("PORTFOLIO_STALE_REVISION",409);
    if(operation==="update-project") {
      if(!input.changes||typeof input.changes!=="object"||Array.isArray(input.changes)||Object.keys(input.changes).some(key=>!['name','summary','url','tags'].includes(key)))throw new PortfolioError("PORTFOLIO_PROJECT_INVALID");
      const v=projectInput({...p,...input.changes});
      const out=await sql.query(`WITH changed AS (UPDATE career_ops_portfolio_projects p SET name=$2,summary=$3,url=$4,tags=$5::jsonb,revision=revision+1 WHERE id=$1 AND revision=$6 AND archived_at IS NULL RETURNING p.*), saved AS (UPDATE career_ops_portfolio_operations o SET result=to_jsonb(changed) FROM changed WHERE o.operation_id=$7 AND o.payload_sha256=$8 RETURNING o.result) SELECT result FROM saved`,[id,v.name,v.summary,v.url,JSON.stringify(v.tags),revision,operationId,payloadHash]);
      if(!out[0])throw new PortfolioError("PORTFOLIO_STALE_REVISION",409);return out[0].result;
    }
    if(operation==="archive-project"||operation==="restore-project") {
      if(input.confirm!==true)throw new PortfolioError("PORTFOLIO_CONFIRMATION_REQUIRED");const archived=operation==="archive-project";
      const out=await sql.query(`WITH changed AS (UPDATE career_ops_portfolio_projects p SET archived_at=$2,revision=revision+1 WHERE id=$1 AND revision=$3 AND (($4::boolean AND archived_at IS NULL) OR (NOT $4::boolean AND archived_at IS NOT NULL)) RETURNING p.*), saved AS (UPDATE career_ops_portfolio_operations o SET result=to_jsonb(changed) FROM changed WHERE o.operation_id=$5 AND o.payload_sha256=$6 RETURNING o.result) SELECT result FROM saved`,[id,archived?new Date().toISOString():null,revision,archived,operationId,payloadHash]);
      if(!out[0])throw new PortfolioError("PORTFOLIO_STALE_REVISION",409);return out[0].result;
    }
    if(operation==="purge-project") {
      const refs=await sql.query("SELECT id FROM career_ops_portfolios WHERE archived_at IS NULL AND project_ids @> $1::jsonb",[JSON.stringify([id])]);
      if(refs.length)throw new PortfolioError("PORTFOLIO_PROJECT_IN_USE",409);
      if(input.confirm!==true||!p.archived_at||input.confirmationName!==p.name)throw new PortfolioError("PORTFOLIO_PURGE_CONFIRMATION_INVALID",409);
      const out=await sql.query(`WITH removed AS (DELETE FROM career_ops_portfolio_projects p WHERE p.id=$1 AND p.revision=$2 AND p.archived_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM career_ops_portfolios f WHERE f.project_ids @> $3::jsonb) RETURNING p.id), saved AS (UPDATE career_ops_portfolio_operations o SET result=jsonb_build_object('id',$1::text,'purged',true) FROM removed WHERE o.operation_id=$4 AND o.payload_sha256=$5 RETURNING o.result) SELECT result FROM saved`,[id,revision,JSON.stringify([id]),operationId,payloadHash]);
      if(!out[0])throw new PortfolioError("PORTFOLIO_PROJECT_IN_USE",409);return out[0].result;
    }
  }
  async function saveGeneratedVersion({portfolioId,runId,lease,document,bytes,expectedRevision,metadata={}}) {
    await initialize();
    if(!UUID.test(String(portfolioId||""))||!UUID.test(String(runId||""))||!UUID.test(String(lease||"")))throw new PortfolioError("PORTFOLIO_RUN_INVALID");
    let normalized;
    try { normalized=normalizePortfolioDocument(document); }
    catch(error) { if(error instanceof PortfolioDocumentError)throw new PortfolioError(error.message);throw error; }
    const documentJson=JSON.stringify(normalized);
    if(Buffer.byteLength(documentJson)>MAX_PORTFOLIO_DOCUMENT_BYTES)throw new PortfolioError("PORTFOLIO_DOCUMENT_SIZE_INVALID",413);
    const meta=validatePortfolioPdf(bytes);const path=`portfolios/${portfolioId}-${runId}.pdf`;
    const rows=await sql.query(`WITH existing AS (SELECT portfolio_id,version,document_path,sha256,byte_size FROM career_ops_portfolio_versions WHERE run_id=$3),
      eligible AS (SELECT r.id FROM career_ops_portfolio_runs r JOIN career_ops_portfolios p ON p.id=r.portfolio_id
        WHERE r.id=$3 AND r.lease=$9 AND r.state='running' AND r.phase='render' AND r.lease_expires_at>now()
          AND p.id=$1 AND p.revision=$2 AND p.archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM existing)
        FOR UPDATE OF r,p),
      project_guard AS (SELECT id FROM career_ops_portfolio_projects WHERE id IN (SELECT jsonb_array_elements_text(COALESCE($10::jsonb->'projectIds','[]'::jsonb))::uuid) AND archived_at IS NULL FOR KEY SHARE),
      parent AS (UPDATE career_ops_portfolios p SET title=COALESCE($10::jsonb->>'title',p.title),kind=COALESCE($10::jsonb->>'kind',p.kind),tags=COALESCE($10::jsonb->'tags',p.tags),project_ids=COALESCE($10::jsonb->'projectIds',p.project_ids),revision=revision+1 FROM eligible e WHERE p.id=$1 AND p.revision=$2 AND (SELECT COUNT(*) FROM project_guard)=jsonb_array_length(COALESCE($10::jsonb->'projectIds','[]'::jsonb)) RETURNING p.id),
      nextv AS (SELECT (COALESCE(MAX(v.version),0)+1)::int n FROM career_ops_portfolio_versions v,parent WHERE v.portfolio_id=parent.id),
      doc AS (INSERT INTO career_ops_documents(path,content,sha256,content_encoding,byte_size,updated_at)
        SELECT $4,$5,$6,'base64',$7,now() FROM parent WHERE NOT EXISTS(SELECT 1 FROM existing) ON CONFLICT(path) DO NOTHING RETURNING path),
      versioned AS (INSERT INTO career_ops_portfolio_versions(portfolio_id,version,document_path,sha256,byte_size,document_json,run_id)
        SELECT parent.id,nextv.n,doc.path,$6,$7,$8::jsonb,$3 FROM parent,nextv,doc RETURNING portfolio_id,version,document_path,sha256,byte_size)
      , completed AS (UPDATE career_ops_portfolio_runs r SET state='completed',pdf_path=versioned.document_path,pdf_sha256=versioned.sha256,pdf_byte_size=versioned.byte_size,version=versioned.version,completed_at=now(),lease=NULL,lease_expires_at=NULL FROM versioned WHERE r.id=$3 AND r.lease=$9 AND r.state='running' RETURNING versioned.*)
      SELECT portfolio_id,version,document_path,sha256,byte_size FROM completed UNION ALL SELECT portfolio_id,version,document_path,sha256,byte_size FROM existing`,
      [portfolioId,expectedRevision,runId,path,bytes.toString("base64"),meta.sha256,meta.byteSize,documentJson,lease,JSON.stringify(metadata||{})]);
    if(!rows[0])throw new PortfolioError("PORTFOLIO_STALE_REVISION",409);
    if(!rows[0].version)throw new PortfolioError("PORTFOLIO_RUN_VERSION_CONFLICT",409);
    if(!rows[0].portfolio_id)throw new PortfolioError("PORTFOLIO_NOT_FOUND",404);
    return {portfolioId,version:Number(rows[0].version),documentPath:rows[0].document_path,sha256:rows[0].sha256,byteSize:Number(rows[0].byte_size),document:normalized};
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
  return { initialize,list,addProject,upload,download,associate,detail,command,saveGeneratedVersion };
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
