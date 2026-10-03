import { neon } from "@neondatabase/serverless";
import { createHash, randomUUID } from "node:crypto";
import { parseApplications, detectColumnMap } from "./tracker-table.mjs";
import { load as parseYaml } from "js-yaml";
import { reserveCareerOpsReportNumber } from "./cloud-report-numbering.mjs";
import { importedPostingPath, normalizeJobUrl, validateJobUrl } from "./job-import.mjs";

const APP = "data/applications.md", INBOX = "data/pipeline.md", STATUS_LOG = "data/status-log.tsv", FOLLOWUPS = "data/follow-ups.md", ALIASES = "data/tracker-aliases.json", PROFILE = "config/profile.yml";
// Keep this checked-in table aligned with templates/states.yml. That system file
// is deliberately absent from the Neon user-document allowlist.
const CANONICAL_STATES = [
  { label: "Evaluated", aliases: ["evaluada", "condicional", "hold", "evaluar", "verificar"] },
  { label: "Applied", aliases: ["aplicado", "enviada", "aplicada", "sent"] },
  { label: "Responded", aliases: ["respondido"] },
  { label: "Interview", aliases: ["entrevista"] },
  { label: "Offer", aliases: ["oferta"] },
  { label: "Rejected", aliases: ["rechazado", "rechazada"] },
  { label: "Discarded", aliases: ["descartado", "descartada", "cerrada", "cancelada"] },
  { label: "SKIP", aliases: ["no_aplicar", "no aplicar", "skip", "monitor", "geo blocker", "geo_blocker"] },
  { label: "Hired", aliases: ["contratado", "contratada", "hired", "accepted", "accept"] },
];
const SOURCES = new Set(["set-status", "correction", "backfill", "manual"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha = x => createHash("sha256").update(x).digest("hex");
const clean = x => String(x ?? "").replace(/[|\r\n]/g, " ").trim();
const cell = x => String(x ?? "").trim();
const esc = x => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function validatePublicUrl(value) {
  if (typeof value !== "string" || value.length > 2048 || value.trim() !== value) throw new Error("INVALID_URL");
  let u; try { u = new URL(value); } catch { throw new Error("INVALID_URL"); }
  if (!/^https?:$/.test(u.protocol) || !u.hostname || u.username || u.password || u.hostname === "localhost" || u.hostname.endsWith(".local") || /^\d+(?:\.\d+){3}$/.test(u.hostname) || /[|\r\n\s]/.test(value)) throw new Error("INVALID_URL");
  return value;
}

function parseTable(md, aliases) {
  const lines = md.split(/\r?\n/), headerIndex=lines.findIndex(line=>detectColumnMap([line],aliases));
  if (headerIndex < 0) throw new Error("TRACKER_FORMAT_INVALID");
  const headers = lines[headerIndex].split("|").slice(1,-1).map(cell), map=detectColumnMap([lines[headerIndex]],aliases);
  const cols = { n:map.n, date:map.date??-1, company:map.company, via:map.via??-1, role:map.role, location:map.location??-1, score:map.score, status:map.status, pdf:map.pdf??-1, report:map.report??-1, notes:map.notes??-1 };
  if (cols.n < 0 || cols.company < 0 || cols.role < 0 || cols.status < 0) throw new Error("TRACKER_FORMAT_INVALID");
  const rows=[];
  for(let i=headerIndex+1;i<lines.length;i++) { const line=lines[i]; if(!/^\s*\|/.test(line))continue; const cells=line.split("|").slice(1,-1).map(cell); if(!/^\d+$/.test(cells[cols.n]||""))continue; if(cells.length!==headers.length)throw new Error("TRACKER_FORMAT_INVALID");rows.push({index:i,cells,number:cells[cols.n]}); }
  return {lines,headers,cols,rows};
}
function formatRow(cells) { return `| ${cells.join(" | ")} |`; }
function inboxAddLine({ url, company, role, location, compensation }) {
  const tail = [location, compensation].map(value => value ? clean(value) : "");
  while (tail.length && !tail.at(-1)) tail.pop();
  return `- [ ] ${url} | ${clean(company)} | ${clean(role)}${tail.map(value => ` | ${value}`).join("")}`;
}
function parseInbox(md) {
  return md.split(/\r?\n/).map((line,index)=>{
    const m=line.match(/^(\s*-\s*\[)([ xX])(\]\s*)(.+)$/); if(!m)return null;
    const pieces=m[4].split("|").map(cell); if(pieces.length<3||!pieces[0]||!pieces[1]||!pieces[2])return null;
    let url; try { url=validatePublicUrl(pieces[0]); } catch { return null; }
    if(url!==pieces[0])return null;
    return {index,line,prefix:m[1],done:m[2].toLowerCase()==="x",spacer:m[3],pieces,url};
  }).filter(Boolean);
}
function checkShape(value, allowed) { if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(k=>!allowed.has(k)))throw new Error("INVALID_REQUEST"); }
function checkFields(kind, input) {
  const common=["operationId","operation"];
  const fields=kind==="tracker"?{
    add:[...common,"company","role","url","source","date","status","score"],
    "set-status":[...common,"applicationId","status","date"],
    "update-notes":[...common,"applicationId","notes"], archive:[...common,"applicationId","confirm"], delete:[...common,"applicationId","confirm"],
  }:{
    add:[...common,"url","company","role","location","compensation"],
    edit:[...common,"targetUrl","newUrl","company","role","location","compensation"],
    archive:[...common,"targetUrl","confirm"], delete:[...common,"targetUrl","confirm"],
  };
  if(!fields[input?.operation])throw new Error("INVALID_OPERATION");
  checkShape(input,new Set(fields[input.operation]));
  for(const [key,value] of Object.entries(input)) if(typeof value==="string"&&value.length>4096)throw new Error("FIELD_TOO_LONG");
}
function hasConfirm(v) { if(v!==true)throw new Error("CONFIRMATION_REQUIRED"); }

function validDate(s) { if(typeof s!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;const d=new Date(`${s}T00:00:00.000Z`);return !Number.isNaN(d.valueOf())&&d.toISOString().slice(0,10)===s; }
function appliedDate(explicit, notes, today) {
  if(explicit!=null) {if(!validDate(explicit))throw new Error("INVALID_DATE");return explicit;}
  const noted=notes.match(/\bApplied\s+(\d{4}-\d{2}-\d{2})\b/i)?.[1];
  if(noted&&!validDate(noted))throw new Error("INVALID_DATE");
  return noted||today;
}
function followupSeed(content, app, applied, setDate, appliedDays) {
  const lines=content.split(/\r?\n/);
  if(lines.some(l=>new RegExp(`^\\s*-\\s*next\\s+#${esc(app.number)}\\b`).test(l))) return content;
  const next=new Date(`${applied}T00:00:00.000Z`); next.setUTCDate(next.getUTCDate()+appliedDays);
  const pin=`- next #${app.number} ${next.toISOString().slice(0,10)} (set ${setDate})`;
  const i=lines.findIndex(l=>/^\s*#\s+Follow-ups/i.test(l));
  if(i<0) return `${content.replace(/\s*$/,"\n")}\n## Follow-ups\n\n${pin}\n`;
  lines.splice(i+1,0,"",pin); return lines.join("\n").replace(/\n*$/,"\n");
}

export function createCloudTrackerManagement({ sql, now = () => new Date() }) {
  let initialized;
  const ready=()=>initialized??=(async()=>{await sql.query(`CREATE TABLE IF NOT EXISTS career_ops_tracker_mutations (id UUID PRIMARY KEY, payload_sha256 TEXT NOT NULL, result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,[]);})();
  async function read(path) { const r=(await sql.query("SELECT path,content,sha256,content_encoding FROM career_ops_documents WHERE path=$1",[path]))[0]; if(!r||r.content_encoding!=="utf8")throw new Error("DOCUMENT_UNAVAILABLE"); return r; }
  async function optional(path) { const r=(await sql.query("SELECT path,content,sha256,content_encoding FROM career_ops_documents WHERE path=$1",[path]))[0]; if(r&&r.content_encoding!=="utf8")throw new Error("DOCUMENT_UNAVAILABLE"); return r??{path,content:"",sha256:null}; }
  async function aliases() { const doc=await optional(ALIASES); if(!doc.content)return {}; try {const parsed=JSON.parse(doc.content);return parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?parsed:{};}catch{throw new Error("TRACKER_ALIASES_INVALID");} }
  async function statusLabels() { return CANONICAL_STATES.map(state=>state.label); }
  async function replay(id,kind,payload) {
    const prior=(await sql.query("SELECT payload_sha256,result FROM career_ops_tracker_mutations WHERE id=$1",[id]))[0];
    if(!prior)return null;
    const mutationHash=sha(JSON.stringify({kind,payload}));
    if(prior.payload_sha256!==mutationHash)throw new Error("IDEMPOTENCY_KEY_CONFLICT");
    return {...(prior.result??{}),replayed:true};
  }
  async function commit(id,kind,payload,docs,result) {
    const mutationHash=sha(JSON.stringify({kind,payload}));
    const incoming=docs.map(d=>({path:d.path,expected_sha:d.old??null,content:d.content,sha256:sha(d.content),byte_size:Buffer.byteLength(d.content)}));
    const statement=`WITH incoming AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset($3::jsonb) AS d(path text, expected_sha text, content text, sha256 text, byte_size integer)
    ), gate AS MATERIALIZED (
      SELECT NOT EXISTS (SELECT 1 FROM incoming i LEFT JOIN career_ops_documents d USING(path) WHERE d.sha256 IS DISTINCT FROM i.expected_sha) AS ok
    ), marker AS (
      INSERT INTO career_ops_tracker_mutations(id,payload_sha256,result) SELECT $1,$2,$4::jsonb FROM gate WHERE ok
      ON CONFLICT(id) DO NOTHING RETURNING id,payload_sha256,result
    ), writes AS (
      INSERT INTO career_ops_documents(path,content,sha256,content_encoding,byte_size,updated_at)
      SELECT i.path,i.content,i.sha256,'utf8',i.byte_size,now() FROM incoming i CROSS JOIN marker
      ON CONFLICT(path) DO UPDATE SET content=EXCLUDED.content,sha256=EXCLUDED.sha256,content_encoding='utf8',byte_size=EXCLUDED.byte_size,updated_at=now()
      WHERE career_ops_documents.sha256 IS NOT DISTINCT FROM (SELECT expected_sha FROM incoming WHERE path=EXCLUDED.path)
      RETURNING path
    ), asserted AS MATERIALIZED (
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM marker) OR totals.written=totals.expected THEN TRUE ELSE 1/(totals.written-totals.written)=1 END AS ok
      FROM (SELECT (SELECT count(*) FROM writes) AS written,(SELECT count(*) FROM incoming) AS expected) totals
    ) SELECT COALESCE((SELECT payload_sha256 FROM marker),(SELECT payload_sha256 FROM career_ops_tracker_mutations WHERE id=$1)) AS payload_sha256,
      COALESCE((SELECT result FROM marker),(SELECT result FROM career_ops_tracker_mutations WHERE id=$1)) AS result,
      EXISTS(SELECT 1 FROM marker) AS applied,
      (SELECT ok FROM gate) AS cas_ok, (SELECT ok FROM asserted) AS writes_ok`;
    let out;
    try { out=(await sql.query(statement,[id,mutationHash,JSON.stringify(incoming),JSON.stringify(result)]))[0]; }
    catch(e) { if(/division by zero/i.test(String(e?.message)))throw new Error("WRITE_CONFLICT"); throw e; }
    if(out?.payload_sha256==null)throw new Error("WRITE_CONFLICT");
    if(out.payload_sha256!==mutationHash)throw new Error("IDEMPOTENCY_KEY_CONFLICT");
    if(!out.applied)return {...(out.result??result),replayed:true};
    if(!out.cas_ok||!out.writes_ok)throw new Error("WRITE_CONFLICT");
    const committed=out.result??result;
    return committed;
  }
  async function addAppliedFollowup(docs, number, explicitDate, notes, today) {
    const [follow,profile]=await Promise.all([optional(FOLLOWUPS),optional(PROFILE)]);
    let appliedDays=7;
    try { const configured=parseYaml(profile.content)?.followup_cadence?.applied_first_days; if(Number.isInteger(configured)&&configured>=0)appliedDays=configured; } catch {}
    const content=followupSeed(follow.content,{number},appliedDate(explicitDate,notes,today),today,appliedDays);
    if(content!==follow.content)docs.push({path:FOLLOWUPS,old:follow.sha256,content});
  }
  async function findImport(input) {
    await ready();
    if (!input || typeof input !== "object" || typeof input.normalizedUrl !== "string" || typeof input.originalUrl !== "string") throw new Error("INVALID_REQUEST");
    const normalizedUrl = normalizeJobUrl(input.normalizedUrl);
    if (normalizedUrl !== input.normalizedUrl) throw new Error("INVALID_URL");
    const [tracker, inbox, aliasMap, aliasDoc, reportDocs] = await Promise.all([
      read(APP), read(INBOX), aliases(), optional(importedPostingPath(normalizedUrl)),
      sql.query("SELECT path,content FROM career_ops_documents WHERE path LIKE 'reports/%' AND content_encoding='utf8'", []),
    ]);
    let canonicalUrl = normalizedUrl, priorRecord = null;
    if (aliasDoc.content) {
      try {
        const aliasRecord = JSON.parse(aliasDoc.content);
        if (aliasRecord.aliasFor) canonicalUrl = normalizeJobUrl(aliasRecord.aliasFor);
        else if (aliasRecord.normalizedUrl === normalizedUrl) priorRecord = aliasRecord;
      } catch { throw new Error("IMPORT_RECORD_INVALID"); }
    }
    if (!priorRecord && canonicalUrl !== normalizedUrl) {
      const canonicalDoc = await optional(importedPostingPath(canonicalUrl));
      if (canonicalDoc.content) { try { priorRecord = JSON.parse(canonicalDoc.content); } catch { throw new Error("IMPORT_RECORD_INVALID"); } }
    }
    const entries = parseInbox(inbox.content);
    const existingEntry = entries.find(entry => {
      try { return normalizeJobUrl(entry.url) === canonicalUrl; } catch { return entry.url === canonicalUrl; }
    });
    let reportMatch = null;
    const trackerRows = parseApplications(tracker.content, "", aliasMap);
    for (const report of reportDocs) {
      const foundUrl = report.content?.match(/^\*\*URL:\*\*\s*(https?:\/\/\S+)/mi)?.[1];
      if (!foundUrl) continue;
      let matches = false; try { matches = normalizeJobUrl(foundUrl) === canonicalUrl; } catch { matches = foundUrl === canonicalUrl; }
      if (!matches) continue;
      const number = String(report.path).match(/^reports\/(\d+)-/)?.[1];
      const row = number ? trackerRows.find(item => item.n === String(Number(number))) : null;
      if (row) { reportMatch = { number: String(Number(number)), company: row.company, role: row.role }; break; }
    }
    if (reportMatch) return { status: "already_exists", existing: true, inboxId: priorRecord?.inboxId ?? `inb_${sha(normalizedUrl).slice(0, 32)}`,
      originalUrl: input.originalUrl, normalizedUrl: existingEntry?.url ?? normalizedUrl, company: reportMatch.company, role: reportMatch.role,
      source: input.source ?? priorRecord?.source ?? null, applicationNumber: reportMatch.number, createdAt: priorRecord?.createdAt ?? null };
    if (existingEntry && (existingEntry.done || !input.forceRefresh)) return { status: "already_exists", existing: true, inboxId: priorRecord?.inboxId ?? `inb_${sha(normalizedUrl).slice(0, 32)}`,
      originalUrl: input.originalUrl, normalizedUrl: existingEntry.url, company: existingEntry.pieces[1] || null, role: existingEntry.pieces[2] || null,
      source: priorRecord?.source ?? input.source ?? null, applicationNumber: null, createdAt: priorRecord?.createdAt ?? null };
    return null;
  }
  async function importPosting(input) {
    await ready();
    if (!input || typeof input !== "object" || typeof input.originalUrl !== "string" || typeof input.normalizedUrl !== "string" ||
        !input.posting || typeof input.posting !== "object" || Array.isArray(input.posting) || typeof input.forceRefresh !== "undefined" && typeof input.forceRefresh !== "boolean") throw new Error("INVALID_REQUEST");
    const url = validateJobUrl(input.normalizedUrl);
    validateJobUrl(input.originalUrl);
    if (normalizeJobUrl(url.href) !== input.normalizedUrl || input.originalUrl.length > 2048) throw new Error("INVALID_URL");
    const requestedNormalizedUrl = input.requestedNormalizedUrl ?? input.normalizedUrl;
    if (typeof requestedNormalizedUrl !== "string" || normalizeJobUrl(requestedNormalizedUrl) !== requestedNormalizedUrl) throw new Error("INVALID_URL");
    const posting = input.posting;
    const company = typeof posting.company === "string" ? posting.company.trim() : "";
    const role = typeof posting.role === "string" ? posting.role.trim() : "";
    const description = typeof posting.jobDescription === "string" ? posting.jobDescription.trim() : "";
    if (!company || company.length > 500 || !role || role.length > 500 || !description || description.length > 24_000) throw new Error("INVALID_POSTING");
    for (const key of ["location", "workArrangement", "employmentType", "compensation", "ats", "externalPostingId"]) {
      if (posting[key] != null && (typeof posting[key] !== "string" || posting[key].length > 500)) throw new Error("INVALID_FIELD");
    }
    if (input.source != null && (typeof input.source !== "string" || input.source.length > 500)) throw new Error("INVALID_FIELD");
    const inboxId = `inb_${sha(input.normalizedUrl).slice(0, 32)}`;
    const sidecarPath = importedPostingPath(input.normalizedUrl);
    const aliasPath = requestedNormalizedUrl !== input.normalizedUrl ? importedPostingPath(requestedNormalizedUrl) : null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const [tracker, inbox, aliasMap, sidecar, aliasDoc, reportDocs] = await Promise.all([
        read(APP), read(INBOX), aliases(), optional(sidecarPath), aliasPath ? optional(aliasPath) : Promise.resolve(null),
        sql.query("SELECT path,content FROM career_ops_documents WHERE path LIKE 'reports/%' AND content_encoding='utf8'", []),
      ]);
      const trackerRows = parseApplications(tracker.content, "", aliasMap);
      const entries = parseInbox(inbox.content);
      const existingEntry = entries.find(entry => {
        try { return normalizeJobUrl(entry.url) === input.normalizedUrl || normalizeJobUrl(entry.url) === requestedNormalizedUrl; } catch { return entry.url === input.normalizedUrl; }
      });
      let reportMatch = null;
      for (const report of reportDocs) {
        const foundUrl = report.content?.match(/^\*\*URL:\*\*\s*(https?:\/\/\S+)/mi)?.[1];
        if (!foundUrl) continue;
        let matches = false;
        try { matches = normalizeJobUrl(foundUrl) === input.normalizedUrl; } catch { matches = foundUrl === input.normalizedUrl; }
        if (!matches) continue;
        const number = String(report.path).match(/^reports\/(\d+)-/)?.[1];
        const trackerRow = number ? trackerRows.find(row => row.n === String(Number(number))) : null;
        if (trackerRow) { reportMatch = { report, number: String(Number(number)), company: trackerRow.company, role: trackerRow.role }; break; }
      }
      const priorRecord = sidecar.content ? (() => { try { const record = JSON.parse(sidecar.content); return record.normalizedUrl === input.normalizedUrl ? record : null; } catch { throw new Error("IMPORT_RECORD_INVALID"); } })() : null;
      if (reportMatch) {
        return { status: "already_exists", existing: true, inboxId, originalUrl: input.originalUrl, normalizedUrl: existingEntry?.url ?? input.normalizedUrl,
          company: reportMatch.company, role: reportMatch.role, source: input.source ?? priorRecord?.source ?? null, applicationNumber: reportMatch.number, createdAt: priorRecord?.createdAt ?? null };
      }
      if (existingEntry && (existingEntry.done || !input.forceRefresh)) {
        return { status: "already_exists", existing: true, inboxId, originalUrl: input.originalUrl, normalizedUrl: existingEntry.url,
          company: existingEntry.pieces[1] || null, role: existingEntry.pieces[2] || null, source: priorRecord?.source ?? input.source ?? null,
          applicationNumber: null, createdAt: priorRecord?.createdAt ?? null };
      }
      const nowValue = now().toISOString();
      const createdAt = priorRecord?.createdAt ?? nowValue;
      const normalizedPosting = {
        inboxId, originalUrl: input.originalUrl, normalizedUrl: input.normalizedUrl, source: input.source?.trim() || posting.source || priorRecord?.source || null,
        company, role, location: typeof posting.location === "string" ? posting.location.trim() || null : null,
        workArrangement: typeof posting.workArrangement === "string" ? posting.workArrangement.trim() || null : null,
        postingDate: typeof posting.postingDate === "string" ? posting.postingDate.trim() || null : null,
        sourceCreatedAt: typeof posting.sourceCreatedAt === "string" ? posting.sourceCreatedAt.trim() || null : null,
        sourceUpdatedAt: typeof posting.sourceUpdatedAt === "string" ? posting.sourceUpdatedAt.trim() || null : null,
        employmentType: typeof posting.employmentType === "string" ? posting.employmentType.trim() || null : null,
        compensation: typeof posting.compensation === "string" ? posting.compensation.trim() || null : null,
        jobDescription: description, ats: typeof posting.ats === "string" ? posting.ats.trim() || null : null,
        externalPostingId: typeof posting.externalPostingId === "string" ? posting.externalPostingId.trim() || null : null,
        createdAt, importedAt: nowValue, ...(priorRecord && input.forceRefresh ? { refreshedAt: nowValue } : {}),
      };
      const lines = inbox.content.split(/\r?\n/);
      if (existingEntry) {
        // A refresh updates the durable JD but preserves the canonical Inbox row.
      } else {
        const dateLabel = /^\d{4}-\d{2}-\d{2}$/.test(normalizedPosting.postingDate ?? "") ? ` | posted: ${clean(normalizedPosting.postingDate)}` : "";
        const sourceLabel = normalizedPosting.source ? ` | source: ${clean(normalizedPosting.source)}` : "";
        const importedLabel = ` | imported: ${nowValue.slice(0, 10)}`;
        lines.push(`${inboxAddLine({ url: input.normalizedUrl, company, role, location: normalizedPosting.location, compensation: normalizedPosting.compensation })}${dateLabel}${sourceLabel}${importedLabel}`);
      }
      const docs = [];
      docs.push({ path: INBOX, old: inbox.sha256, content: existingEntry ? inbox.content : lines.join("\n").replace(/\n*$/, "\n") });
      docs.push({ path: APP, old: tracker.sha256, content: tracker.content });
      const keepGoodRecord = priorRecord && !input.forceRefresh;
      const stored = keepGoodRecord ? priorRecord : normalizedPosting;
      docs.push({ path: sidecarPath, old: sidecar.sha256, content: JSON.stringify(stored) });
      if (aliasPath) docs.push({ path: aliasPath, old: aliasDoc?.sha256 ?? null, content: JSON.stringify({ inboxId, normalizedUrl: input.normalizedUrl, aliasFor: input.normalizedUrl, originalUrl: input.originalUrl, source: stored.source }) });
      const result = { status: existingEntry ? "already_exists" : "imported", existing: Boolean(existingEntry), inboxId,
        originalUrl: input.originalUrl, normalizedUrl: input.normalizedUrl, company: stored.company, role: stored.role,
        source: stored.source, applicationNumber: null, createdAt: stored.createdAt };
      try {
        const committed = await commit(randomUUID(), "job-import", { url: input.normalizedUrl, forceRefresh: Boolean(input.forceRefresh), source: input.source ?? null, inboxId }, docs, result);
        return committed;
      } catch (error) {
        if (error?.message !== "WRITE_CONFLICT" || attempt === 4) throw error;
      }
    }
    throw new Error("WRITE_CONFLICT");
  }
  async function mutate(kind,input) {
    if(!["tracker","inbox"].includes(kind))throw new Error("INVALID_OPERATION");
    await ready(); checkFields(kind,input);
    const id=input.operationId; if(!UUID.test(id||""))throw new Error("INVALID_OPERATION_ID");
    const prior=await replay(id,kind,input); if(prior)return prior;
    const [tracker,inbox,aliasMap,validStatuses]=await Promise.all([read(APP),kind==="inbox"?read(INBOX):null,aliases(),kind==="tracker"?statusLabels():Promise.resolve([])]), t=parseTable(tracker.content,aliasMap), rows=parseApplications(tracker.content,"",aliasMap), today=now().toISOString().slice(0,10);
    const docs=[], result={ok:true,operation:input.operation}; let statusLine=null, nextFollow=null;
    if(kind==="tracker") {
      const op=input.operation;
      if(op==="add") {
        if(typeof input.company!=="string"||!input.company.trim()||input.company.length>500||typeof input.role!=="string"||!input.role.trim()||input.role.length>500||typeof input.url!=="string")throw new Error("REQUIRED_FIELDS");
        const url=validatePublicUrl(input.url); if(typeof input.source!=="string"||!input.source.trim())throw new Error("REQUIRED_FIELDS");
        if(!validStatuses.includes(input.status))throw new Error("INVALID_STATUS");
        if(input.date!=null&&!validDate(input.date))throw new Error("INVALID_DATE");
        const num=await reserveCareerOpsReportNumber(sql), cells=Array(t.headers.length).fill("");
        const put=(k,v)=>{if(t.cols[k]>=0)cells[t.cols[k]]=clean(v);};
        put("n",num);put("date",input.date||today);put("company",input.company);put("role",input.role);put("status",input.status);put("via",input.source);put("score",input.score||"");put("report","");put("pdf","");put("notes",`Added manually from ${url}`);
        if(input.score&& !/^(?:[1-4](?:\.\d)?|5(?:\.0)?)\s*\/\s*5$/.test(input.score))throw new Error("INVALID_SCORE");
        t.lines.push(formatRow(cells)); docs.push({path:APP,old:tracker.sha256,content:t.lines.join("\n").replace(/\n*$/,"\n")});
        const log=await optional(STATUS_LOG);if(!SOURCES.has("manual"))throw new Error("STATUS_SOURCE_INVALID");docs.push({path:STATUS_LOG,old:log.sha256,content:`${log.content}${num}\t${input.date||today}\t-\t${input.status}\tmanual\tManual tracker entry\n`});
        if(input.status==="Applied")await addAppliedFollowup(docs,num,input.date??null,"",today);
        result.application={n:num,company:input.company.trim(),role:input.role.trim(),status:input.status,score:input.score||null,report:null};
      } else {
        const matches=rows.filter(x=>x.n===String(input.applicationId)); if(!matches.length)throw new Error("APPLICATION_NOT_FOUND"); if(matches.length>1)throw new Error("APPLICATION_ID_AMBIGUOUS"); const app=matches[0];
        const row=t.rows.find(x=>x.number===app.n); if(!row)throw new Error("APPLICATION_NOT_FOUND");
        if(["archive","delete"].includes(op)) {hasConfirm(input.confirm); if(op==="archive"){const from=row.cells[t.cols.status]||"-";row.cells[t.cols.status]="Discarded";if(from!=="Discarded")statusLine=`${app.n}\t${today}\t${from}\tDiscarded\tset-status\tArchived by user\n`;} else {t.lines.splice(row.index,1);} }
        else if(op==="set-status") {const to=input.status;if(!validStatuses.includes(to))throw new Error("INVALID_STATUS");if(input.date!=null&&!validDate(input.date))throw new Error("INVALID_DATE");const from=row.cells[t.cols.status]||"-";row.cells[t.cols.status]=to; if(from!==to)statusLine=`${app.n}\t${input.date||today}\t${from}\t${to}\tset-status\t\n`; if(to==="Applied"&&from!==to)await addAppliedFollowup(docs,app.n,input.date??null,row.cells[t.cols.notes]||"",today); }
        else if(op==="update-notes"){if(typeof input.notes!=="string"||input.notes.length>4000||t.cols.notes<0)throw new Error("INVALID_NOTES");row.cells[t.cols.notes]=clean(input.notes);}
        else throw new Error("INVALID_OPERATION");
        if(op!=="delete")t.lines[row.index]=formatRow(row.cells);
        docs.push({path:APP,old:tracker.sha256,content:t.lines.join("\n").replace(/\n*$/,"\n")});result.application={n:app.n,operation:op};
      }
      if(statusLine){const log=await optional(STATUS_LOG);if(!SOURCES.has("set-status"))throw new Error("STATUS_SOURCE_INVALID");docs.push({path:STATUS_LOG,old:log.sha256,content:log.content+statusLine});}
    } else {
      const op=input.operation, target=validatePublicUrl(op==="add"?input.url:input.targetUrl), lines=inbox.content.split(/\r?\n/), found=parseInbox(inbox.content).filter(x=>x.url===target); if(found.length>1)throw new Error("INBOX_TARGET_AMBIGUOUS"); const item=found[0];
      if(op==="add"){if(item)throw new Error("INBOX_DUPLICATE_URL");if(!input.company?.trim()||input.company.length>500||!input.role?.trim()||input.role.length>500)throw new Error("REQUIRED_FIELDS");for(const k of ["location","compensation"])if(input[k]!==undefined&&(typeof input[k]!=="string"||input[k].length>500))throw new Error("INVALID_FIELD");lines.push(inboxAddLine({ url: target, ...input }));}
      else {if(!item)throw new Error("INBOX_URL_NOT_FOUND");if(op==="archive"){hasConfirm(input.confirm);lines[item.index]=`${item.prefix}x${item.spacer}${item.pieces.join(" | ")}`;}else if(op==="delete"){hasConfirm(input.confirm);lines.splice(item.index,1);}else if(op==="edit"){if(input.newUrl!==undefined){const next=validatePublicUrl(input.newUrl);if(next!==target&&parseInbox(inbox.content).some(x=>x.url===next))throw new Error("INBOX_DUPLICATE_URL");item.pieces[0]=next;}for(const k of ["company","role","location","compensation"]){if(input[k]!==undefined){const at={company:1,role:2,location:3,compensation:4}[k];if(typeof input[k]!=="string"||input[k].length>500||((k==="company"||k==="role")&&!input[k].trim()))throw new Error("INVALID_FIELD");item.pieces[at]=clean(input[k]);} }lines[item.index]=`${item.prefix}${item.done?"x":" "}${item.spacer}${item.pieces.join(" | ")}`;}else throw new Error("INVALID_OPERATION");}
      docs.push({path:INBOX,old:inbox.sha256,content:lines.join("\n").replace(/\n*$/,"\n")});result.url=target;result.operation=op;
    }
    return commit(id,kind,input,docs,result);
  }
  return { async getApplication(id){await ready();if(!/^\d{1,8}$/.test(id))throw new Error("INVALID_APPLICATION_ID");const [doc,aliasMap]=await Promise.all([read(APP),aliases()]);const matches=parseApplications(doc.content,"",aliasMap).filter(x=>x.n===id);if(!matches.length)throw new Error("APPLICATION_NOT_FOUND");if(matches.length>1)throw new Error("APPLICATION_ID_AMBIGUOUS");return matches[0];}, mutate, importPosting, findImport };
}

let envStore;
export function createCloudTrackerManagementFromEnv() {
  if(!process.env.DATABASE_URL)throw new Error("CLOUD_DATA_UNAVAILABLE");
  if(envStore)return envStore;
  const sql=neon(process.env.DATABASE_URL);
  envStore=createCloudTrackerManagement({sql});
  return envStore;
}

const ERRORS = new Map([
  ["APPLICATION_NOT_FOUND",404],["INBOX_URL_NOT_FOUND",404],["INVALID_APPLICATION_ID",400],["INVALID_OPERATION_ID",400],
  ["APPLICATION_ID_AMBIGUOUS",409],
  ["INVALID_OPERATION",400],["INVALID_REQUEST",400],["REQUIRED_FIELDS",400],["INVALID_URL",400],["INBOX_FORMAT_INVALID",409],
  ["TRACKER_FORMAT_INVALID",409],["INVALID_STATUS",400],["INVALID_DATE",400],["INVALID_SCORE",400],["INVALID_NOTES",400],
  ["INVALID_FIELD",400],["CONFIRMATION_REQUIRED",400],["INBOX_DUPLICATE_URL",409],["INBOX_TARGET_AMBIGUOUS",409],
  ["IDEMPOTENCY_KEY_CONFLICT",409],["WRITE_CONFLICT",409],["DOCUMENT_UNAVAILABLE",503],["STATE_CONFIG_INVALID",503],
  ["TRACKER_ALIASES_INVALID",503],["CLOUD_DATA_UNAVAILABLE",503],["FIELD_TOO_LONG",400],
]);
function fail(error) {
  const code=String(error?.message||""); const status=ERRORS.get(code)||500;
  return Response.json({code:ERRORS.has(code)?code:"TRACKER_REQUEST_FAILED"},{status,headers:{"Cache-Control":"no-store"}});
}
async function parseCommand(request) {
  if(!request.headers.get("content-type")?.includes("application/json"))return {response:Response.json({code:"JSON_REQUIRED"},{status:415,headers:{"Cache-Control":"no-store"}})};
  const declared=Number(request.headers.get("content-length")||0); if(declared>16_384)return {response:Response.json({code:"REQUEST_TOO_LARGE"},{status:413,headers:{"Cache-Control":"no-store"}})};
  const text=await request.text(); if(Buffer.byteLength(text,"utf8")>16_384)return {response:Response.json({code:"REQUEST_TOO_LARGE"},{status:413,headers:{"Cache-Control":"no-store"}})};
  try{return {body:JSON.parse(text)};}catch{return {response:Response.json({code:"BAD_JSON"},{status:400,headers:{"Cache-Control":"no-store"}})};}
}
export async function handleCloudTrackerGet(applicationId) {
  try {const application=await createCloudTrackerManagementFromEnv().getApplication(applicationId);return Response.json({application},{headers:{"Cache-Control":"no-store"}});}
  catch(error){return fail(error);}
}
export async function handleCloudTrackerCommand(request,kind) {
  const parsed=await parseCommand(request);if(parsed.response)return parsed.response;
  try {const result=await createCloudTrackerManagementFromEnv().mutate(kind,parsed.body);return Response.json(result,{headers:{"Cache-Control":"no-store"}});}
  catch(error){return fail(error);}
}
