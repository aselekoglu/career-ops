import { createHash } from "node:crypto";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export const MAX_POSTING_BYTES = 1_000_000;
export const MAX_REDIRECTS = 4;
export const TOTAL_TIMEOUT_MS = 12_000;
const TRACKING = new Set(["gclid", "dclid", "fbclid", "msclkid", "mc_cid", "mc_eid"]);
const SAFE_USER_AGENT = "Career-Ops-Job-Importer/1.0";
function dateOnly(value) {
  const text = typeof value === "string" ? value : "";
  if (!text) return null;
  const date = new Date(text);
  return Number.isFinite(date.valueOf()) ? date.toISOString().slice(0, 10) : null;
}

function parseIpv6(value) {
  const input = String(value).toLowerCase();
  if (!input || input.includes("%") || net.isIP(input) !== 6) return null;
  const halves = input.split("::");
  if (halves.length > 2) return null;
  const parseSide = side => side ? side.split(":").map(part => /^[0-9a-f]{1,4}$/.test(part) ? parseInt(part, 16) : NaN) : [];
  let words = [...parseSide(halves[0]), ...parseSide(halves[1] ?? "")];
  if (words.some(Number.isNaN)) return null;
  if (halves.length === 2) {
    const zeros = 8 - words.length;
    if (zeros < 1) return null;
    words = [...parseSide(halves[0]), ...Array(zeros).fill(0), ...parseSide(halves[1])];
  }
  if (words.length !== 8) return null;
  return words.reduce((value, word) => (value << 16n) | BigInt(word), 0n);
}
function inV6Range(value, prefix, bits) { return value >> BigInt(128 - bits) === prefix; }
function isPublicV4(value) {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const n = (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
  const cidrs = [
    [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16],
    [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24], [0xc0586300, 24], [0xc0a80000, 16], [0xc6120000, 15],
    [0xc6336400, 24], [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
  ];
  return !cidrs.some(([base, bits]) => n >>> (32 - bits) === base >>> (32 - bits));
}

export function isPublicAddress(address) {
  const version = net.isIP(String(address));
  if (version === 4) return isPublicV4(String(address));
  if (version !== 6) return false;
  const value = parseIpv6(address);
  if (value == null) return false;
  // Only global unicast is accepted. Explicitly reject IPv4-compatible,
  // mapped, translation, documentation, 6to4, and Teredo ranges.
  if (!inV6Range(value, 1n, 3)) return false; // 2000::/3
  if (inV6Range(value, 0x20010db8n, 32) || inV6Range(value, 0x100080n, 23) || inV6Range(value, 0x3fff0n, 20) ||
      inV6Range(value, 0x2002n, 16) || inV6Range(value, 0x64ff9bn, 48) ||
      inV6Range(value, 0x64ff9b0001n, 48)) return false;
  return true;
}

export function validateJobUrl(value) {
  if (typeof value !== "string" || value.length < 8 || value.length > 2048 || value.trim() !== value || /[\u0000-\u0020\u007f\\]/.test(value)) {
    throw new Error("INVALID_URL");
  }
  let url;
  try { url = new URL(value); } catch { throw new Error("INVALID_URL"); }
  if (!/^https?:$/.test(url.protocol)) throw new Error("UNSUPPORTED_SCHEME");
  if (!url.hostname || url.username || url.password) throw new Error("INVALID_URL");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("PRIVATE_NETWORK_BLOCKED");
  if (net.isIP(host) && !isPublicAddress(host)) throw new Error("PRIVATE_NETWORK_BLOCKED");
  return url;
}

export function normalizeJobUrl(value) {
  const url = validateJobUrl(value);
  const host = url.hostname.toLowerCase();
  url.hostname = host;
  if (/(^|\.)(?:lever\.co|greenhouse\.io|ashbyhq\.com|myworkdayjobs\.com)$/i.test(host)) url.protocol = "https:";
  url.hash = "";
  let pathname = url.pathname;
  const lever = host === "jobs.lever.co" || host === "jobs.eu.lever.co";
  const greenhouse = /(^|\.)greenhouse\.io$/.test(host);
  const workday = /\.wd[\w-]*\.myworkdayjobs\.com$/i.test(host);
  if (lever) pathname = pathname.replace(/\/apply\/?$/i, "");
  const ashby = host === "jobs.ashbyhq.com";
  if (ashby) pathname = pathname.replace(/\/application\/?$/i, "");
  if (lever || ashby || greenhouse || workday) pathname = pathname.replace(/\/$/, "");
  url.pathname = pathname;
  const kept = [...url.searchParams.entries()].filter(([key]) => {
    const lower = key.toLowerCase();
    return !lower.startsWith("utm_") && !TRACKING.has(lower) &&
      !((lever || ashby) && ["source", "referrer", "ref"].includes(lower)) && !(greenhouse && lower === "gh_src");
  });
  url.search = "";
  for (const [key, val] of kept) url.searchParams.append(key, val);
  return url.href;
}

async function resolvePublic(host) {
  const cleanHost = host.replace(/^\[|\]$/g, "");
  if (net.isIP(cleanHost)) {
    if (!isPublicAddress(cleanHost)) throw new Error("PRIVATE_NETWORK_BLOCKED");
    return [{ address: cleanHost, family: net.isIP(cleanHost) }];
  }
  let rows;
  try { rows = await dns.lookup(cleanHost, { all: true, verbatim: true }); }
  catch { throw new Error("DNS_FAILED"); }
  if (!rows.length || rows.some(row => !isPublicAddress(row.address))) throw new Error("PRIVATE_NETWORK_BLOCKED");
  return rows;
}

function pinnedLookup(addresses) {
  return (hostname, options, callback) => {
    const selected = addresses[0];
    if (typeof options === "function") callback = options;
    if (options?.all) callback(null, addresses.map(row => ({ address: row.address, family: row.family })));
    else callback(null, selected.address, selected.family);
  };
}

function requestText({ url, addresses, lookup, timeoutMs, maxBytes, signal }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("FETCH_TIMEOUT")); return; }
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(url, {
      method: "GET",
      agent: false,
      lookup,
      signal,
      servername: url.hostname.replace(/^\[|\]$/g, ""),
      headers: { "User-Agent": SAFE_USER_AGENT, Accept: "text/html,application/json,application/ld+json;q=0.9,*/*;q=0.1", "Accept-Encoding": "identity" },
    }, response => {
      const declared = Number(response.headers["content-length"] ?? 0);
      if (declared > maxBytes) { response.destroy(); reject(new Error("FETCH_TOO_LARGE")); return; }
      const chunks = []; let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > maxBytes) { response.destroy(new Error("FETCH_TOO_LARGE")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    const abort = () => req.destroy(new Error("FETCH_TIMEOUT"));
    signal.addEventListener("abort", abort, { once: true });
    req.setTimeout(timeoutMs, abort);
    req.on("error", reject);
    req.on("close", () => signal.removeEventListener("abort", abort));
    req.end();
  });
}

export async function fetchPublicPosting(value, options = {}) {
  const resolve = options.resolve ?? resolvePublic;
  const request = options.request ?? requestText;
  const maxBytes = options.maxBytes ?? MAX_POSTING_BYTES;
  const timeoutMs = options.timeoutMs ?? TOTAL_TIMEOUT_MS;
  const started = Date.now();
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let url = validateJobUrl(value);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      let remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) throw new Error("FETCH_TIMEOUT");
      const addresses = await raceTimeout(resolve(url.hostname), remaining);
      if (!addresses?.length || addresses.some(row => !isPublicAddress(row.address))) throw new Error("PRIVATE_NETWORK_BLOCKED");
      remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0 || controller.signal.aborted) throw new Error("FETCH_TIMEOUT");
      const response = await raceTimeout(request({ url, addresses, lookup: pinnedLookup(addresses), timeoutMs: remaining, maxBytes, signal: controller.signal }), remaining);
      const location = response.headers?.location;
      if ([301, 302, 303, 307, 308].includes(response.status) && location) {
        if (redirects === MAX_REDIRECTS) throw new Error("TOO_MANY_REDIRECTS");
        url = validateJobUrl(new URL(location, url).href);
        continue;
      }
      if (response.status === 404 || response.status === 410) throw new Error("POSTING_NOT_FOUND");
      if (response.status < 200 || response.status >= 300) throw new Error("FETCH_FAILED");
      const body = String(response.body ?? "");
      if (Buffer.byteLength(body, "utf8") > maxBytes) throw new Error("FETCH_TOO_LARGE");
      return { ok: true, body, finalUrl: url.href, contentType: response.headers?.["content-type"] ?? response.headers?.get?.("content-type") ?? "" };
    }
    throw new Error("TOO_MANY_REDIRECTS");
  } catch (error) {
    const code = ["INVALID_URL", "UNSUPPORTED_SCHEME", "PRIVATE_NETWORK_BLOCKED", "DNS_FAILED", "POSTING_NOT_FOUND", "FETCH_TIMEOUT", "FETCH_TOO_LARGE", "TOO_MANY_REDIRECTS"].includes(error?.message) ? error.message : "FETCH_FAILED";
    return { ok: false, error: code };
  } finally {
    clearTimeout(timer);
  }
}

function raceTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("FETCH_TIMEOUT")), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

function decodeEntities(text) {
  return String(text ?? "").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#(\d+);/g, (_, n) => decodeCodepoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => decodeCodepoint(parseInt(n, 16)));
}
function decodeCodepoint(value) { return Number.isInteger(value) && value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : "�"; }
function htmlText(text) {
  return decodeEntities(String(text ?? "").replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ").replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6])\s*>/gi, "\n").replace(/<[^>]+>/g, " "))
    .replace(/[\t \u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function scripts(html) {
  const values = [];
  for (const match of String(html).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\btype\s*=\s*["']application\/ld\+json["']/i.test(match[1])) {
      try { values.push(JSON.parse(match[2].replace(/^\s*<!--|-->\s*$/g, ""))); } catch { /* invalid external metadata is ignored */ }
    }
  }
  return values;
}
function findJobPostings(value, output = []) {
  if (Array.isArray(value)) { for (const item of value) findJobPostings(item, output); return output; }
  if (!value || typeof value !== "object") return output;
  const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
  if (types.includes("JobPosting")) output.push(value);
  else { findJobPostings(value["@graph"], output); findJobPostings(value.mainEntity, output); }
  return output;
}
function structuredPosting(html, url) {
  const all = scripts(html).flatMap(value => findJobPostings(value));
  if (all.length <= 1) return { value: all[0] ?? null, ambiguous: false };
  const target = normalizeJobUrl(url);
  const exact = all.filter(item => [item.url, item["@id"], item.mainEntityOfPage?.url, item.mainEntityOfPage]
    .some(candidate => { try { return typeof candidate === "string" && normalizeJobUrl(new URL(candidate, url).href) === target; } catch { return false; } }));
  return exact.length === 1 ? { value: exact[0], ambiguous: false } : { value: null, ambiguous: true };
}
function plain(value) { return value == null ? null : htmlText(typeof value === "string" ? value : JSON.stringify(value)) || null; }
function locationFromPosting(value) {
  const locs = Array.isArray(value) ? value : value ? [value] : [];
  const parts = locs.map(item => {
    const a = item?.address ?? item;
    return [a?.addressLocality, a?.addressRegion, a?.addressCountry?.name ?? a?.addressCountry].filter(x => typeof x === "string" && x.trim()).join(", ");
  }).filter(Boolean);
  return parts.length ? [...new Set(parts)].join("; ") : null;
}
function salaryFromPosting(value) {
  if (!value) return null;
  const currency = value.currency ?? value.currencyCode;
  const amount = value.value ?? value;
  const min = amount.minValue ?? amount.value;
  const max = amount.maxValue;
  if (min == null && max == null) return null;
  const quantity = min != null && max != null && min !== max ? `${min}-${max}` : String(min ?? max);
  const unit = amount.unitText ? ` ${amount.unitText}` : "";
  return `${currency ? `${currency} ` : ""}${quantity}${unit}`;
}
function metaValue(html, key, attribute = "property") {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tag = new RegExp(`<meta\\b(?=[^>]*\\b${attribute}\\s*=\\s*["']${escaped}["'])(?=[^>]*\\bcontent\\s*=\\s*["']([^"']*)["'])[^>]*>`, "i");
  return decodeEntities(html.match(tag)?.[1] ?? "").trim() || null;
}

const genericTitle = value => {
  const lower = String(value ?? "").toLowerCase().trim();
  const head = lower.split(/[|–—]/)[0].trim();
  return !lower || new Set(["careers", "career opportunities", "join us", "join our team", "open positions", "current openings", "jobs", "job opportunities", "position not found", "job not found", "role not found"] ).has(head) ||
    /^(?:careers?|jobs?)\s+(?:at|with|for|@)\b/.test(lower) || /\b(?:careers?|job openings?)\s+(?:at|with|for)\b/.test(lower) ||
    /\b(?:no longer available|position closed|job expired|page not found)\b/.test(lower);
};
function companyFromSiteMeta(html) {
  const value = metaValue(html, "og:site_name") ?? metaValue(html, "application-name", "name");
  if (!value) return null;
  const parts = value.split("|").map(part => part.trim()).filter(Boolean);
  if (parts.length > 1 && /career|job/i.test(parts[0])) return parts.at(-1);
  return value.replace(/\s+(?:careers?|jobs?)$/i, "").trim() || null;
}
function brandedMetaTitle(html) {
  let title = metaValue(html, "og:title");
  const site = metaValue(html, "og:site_name");
  const parts = site?.split("|").map(x => x.trim()).filter(Boolean) ?? [];
  const brand = parts.at(-1), label = parts[0];
  if (title && brand && label && /career|job/i.test(label)) {
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    title = title.replace(new RegExp(`\\s*[|–—-]\\s*(?:${escape(label)}(?:\\s*[|–—-]\\s*${escape(brand)})?|${escape(label)}|${escape(brand)})\\s*$`, "i"), "").trim();
  }
  return genericTitle(title) ? null : title;
}
function markedDescription(html) {
  const opening = /<(div|section|article)\b([^>]*)>/gi;
  for (const match of html.matchAll(opening)) {
    const marker = match[2].match(/(?:class|id)\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
    if (!/(?:^|[\s_-])(?:job[-_ ]?)?description(?:$|[\s_-])/i.test(marker)) continue;
    const tag = match[1].toLowerCase(), tokens = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
    tokens.lastIndex = match.index;
    let depth = 0, end = -1, token;
    while ((token = tokens.exec(html))) {
      if (new RegExp(`^<${tag}\\b`, "i").test(token[0])) depth++; else depth--;
      if (depth === 0) { end = tokens.lastIndex; break; }
    }
    if (end > match.index) return htmlText(html.slice(match.index, end));
  }
  return null;
}

export function extractJobPosting(html, url) {
  const selected = structuredPosting(html, url), structured = selected.value;
  const headings = [...html.matchAll(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/gi)].map(match => htmlText(match[1]));
  const title = plain(structured?.title) ?? brandedMetaTitle(html) ?? headings.find(value => !genericTitle(value)) ?? null;
  let company = plain(structured?.hiringOrganization?.name) ?? companyFromSiteMeta(html);
  const description = plain(structured?.description) ?? markedDescription(html);
  const provider = resolveAtsPosting(url);
  const externalPostingId = provider?.id ?? null;
  if (/^(?:lever|greenhouse|ashby|workday|smartrecruiters|icims)(?: careers| jobs)?$/i.test(String(company ?? "").trim())) company = null;
  const validThroughText = typeof structured?.validThrough === "string" ? structured.validThrough : "";
  const validThrough = validThroughText ? new Date(validThroughText) : null;
  const validThroughPassed = validThroughText && /^\d{4}-\d{2}-\d{2}$/.test(validThroughText)
    ? validThroughText < new Date().toISOString().slice(0, 10)
    : Boolean(validThrough && Number.isFinite(validThrough.valueOf()) && validThrough.valueOf() < Date.now());
  const expired = Boolean(validThroughPassed);
  const remote = structured?.jobLocationType === "TELECOMMUTE" ? "Remote" : null;
  return {
    company,
    role: selected.ambiguous ? null : title,
    location: locationFromPosting(structured?.jobLocation) ?? plain(structured?.jobLocationType === "TELECOMMUTE" ? "Remote" : null),
    workArrangement: remote,
    postingDate: dateOnly(structured?.datePosted),
    employmentType: plain(structured?.employmentType),
    compensation: salaryFromPosting(structured?.baseSalary),
    jobDescription: selected.ambiguous ? null : description,
    ats: provider?.ats ?? null,
    externalPostingId,
    expired,
    ambiguousPosting: selected.ambiguous,
  };
}

function parseLever(raw) {
  let value; try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.text !== "string") return null;
  const id = String(value.id ?? "");
  const lists = Array.isArray(value.lists) ? value.lists.map(item => [plain(item?.text), plain(item?.content)].filter(Boolean).join("\n")).filter(Boolean) : [];
  const description = [plain(value.descriptionPlain) ?? plain(value.description), ...lists].filter(Boolean).join("\n\n") || null;
  const createdAt = value.createdAt ? new Date(value.createdAt) : null;
  return {
    company: null,
    role: plain(value.text),
    location: plain(value.categories?.location),
    workArrangement: plain(value.workplaceType),
    postingDate: null,
    sourceCreatedAt: createdAt && Number.isFinite(createdAt.valueOf()) ? createdAt.toISOString() : null,
    employmentType: plain(value.categories?.commitment),
    compensation: plain(value.salaryRange),
    jobDescription: description,
    ats: "lever",
    externalPostingId: id || null,
  };
}

function safeSegment(value) { return typeof value === "string" && /^[A-Za-z0-9._-]+$/.test(value) && !value.includes("..") && value.length <= 180; }
export function resolveAtsPosting(value) {
  let url; try { url = validateJobUrl(value); } catch { return null; }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase(); let match;
  if (/(^|\.)greenhouse\.io$/.test(host) && (match = url.pathname.match(/^\/([^/]+)\/jobs\/(\d+)\/?$/)) && safeSegment(match[1])) {
    return { ats: "greenhouse", apiUrl: `https://boards-api.greenhouse.io/v1/boards/${match[1]}/jobs/${match[2]}`, id: match[2] };
  }
  if ((match = host.match(/^jobs\.((?:eu\.)?lever\.co)$/)) && (match = url.pathname.match(/^\/([^/]+)\/([^/?#]+)(?:\/apply)?\/?$/)) && safeSegment(match[1]) && safeSegment(match[2])) {
    return { ats: "lever", apiUrl: `https://api.${host.slice(5)}/v0/postings/${match[1]}/${match[2]}?mode=json`, site: match[1], id: match[2] };
  }
  if (host === "jobs.ashbyhq.com" && (match = url.pathname.match(/^\/([^/]+)\/([^/]+)(?:\/application)?\/?$/)) && safeSegment(match[1]) && safeSegment(match[2])) {
    return { ats: "ashby", apiUrl: `https://api.ashbyhq.com/posting-api/job-board/${match[1]}`, org: match[1], id: match[2] };
  }
  const workday = `${host}${url.pathname}`.match(/^([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)\/job\/(.+?)\/?$/);
  if (workday) {
    const [, tenant, shard, site, jobPath] = workday;
    if (safeSegment(tenant) && safeSegment(shard) && safeSegment(site) && jobPath.split("/").every(safeSegment)) {
      return { ats: "workday", apiUrl: `https://${tenant}.${shard}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/job/${jobPath}`, tenant, site, id: jobPath.split("/").at(-1) };
    }
  }
  return null;
}
function parseAtsPosting(resolved, body) {
  if (resolved.ats === "lever") {
    const parsed = parseLever(body);
    return parsed ? { ...parsed, externalPostingId: parsed.externalPostingId ?? resolved.id } : null;
  }
  let value; try { value = JSON.parse(body); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (resolved.ats === "greenhouse") {
    if (value.id == null || String(value.id) !== resolved.id || typeof value.title !== "string") return null;
    return { company: null, role: plain(value.title), location: plain(value.location?.name), workArrangement: null, postingDate: null, sourceUpdatedAt: plain(value.updated_at), employmentType: null,
      compensation: null, jobDescription: plain(value.content), ats: "greenhouse", externalPostingId: String(value.id) };
  }
  if (resolved.ats === "workday") {
    const info = value.jobPostingInfo;
    if (!info || typeof info !== "object" || typeof info.title !== "string") return null;
    return { company: plain(info.company?.name ?? info.companyName ?? (typeof info.company === "string" ? info.company : null)), role: plain(info.title), location: plain(info.location?.descriptor ?? info.location), workArrangement: plain(info.remoteType), postingDate: dateOnly(info.jobPostingDate),
      employmentType: plain(info.timeType), compensation: plain(info.compensation), jobDescription: plain(info.jobDescription), ats: "workday", externalPostingId: plain(info.jobReqId) ?? resolved.id };
  }
  if (resolved.ats === "ashby") {
    const job = Array.isArray(value.jobs) ? value.jobs.find(item => String(item?.id ?? "").toLowerCase() === resolved.id.toLowerCase()) : null;
    if (!job || job.isListed === false) return null;
    return { company: null, role: plain(job.title), location: plain(job.location), workArrangement: plain(job.workplaceType), postingDate: dateOnly(job.publishedAt), employmentType: plain(job.employmentType),
      compensation: plain(job.compensationTierSummary), jobDescription: plain(job.descriptionPlain) ?? plain(job.descriptionHtml), ats: "ashby", externalPostingId: String(job.id) };
  }
  return null;
}

export function importedPostingPath(normalizedUrl) {
  const digest = createHash("sha256").update(normalizedUrl).digest("hex");
  return `data/job-imports/${digest}.json`;
}

export async function importPosting(value, { source = null, resolve, request } = {}) {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  const networkOptions = () => ({ resolve, request, timeoutMs: Math.max(1, deadline - Date.now()) });
  let originalUrl = typeof value === "string" ? value : "";
  let normalizedUrl;
  try { normalizedUrl = normalizeJobUrl(originalUrl); }
  catch (error) { return { ok: false, originalUrl, error: error?.message === "UNSUPPORTED_SCHEME" ? "UNSUPPORTED_SCHEME" : error?.message === "PRIVATE_NETWORK_BLOCKED" ? "PRIVATE_NETWORK_BLOCKED" : "INVALID_URL" }; }
  const requestedNormalizedUrl = normalizedUrl;
  let fields = null;
  const identity = resolveAtsPosting(normalizedUrl);
  if (identity) {
    if (Date.now() >= deadline) return { ok: false, originalUrl, normalizedUrl, error: "FETCH_TIMEOUT" };
    const api = await fetchPublicPosting(identity.apiUrl, networkOptions());
    if (api.ok) fields = parseAtsPosting(identity, api.body);
    if (!api.ok && api.error === "PRIVATE_NETWORK_BLOCKED") return { ok: false, originalUrl, normalizedUrl, error: api.error };
    if (!fields && ["POSTING_NOT_FOUND", "PRIVATE_NETWORK_BLOCKED"].includes(api.error)) return { ok: false, originalUrl, normalizedUrl, error: api.error };
    if (api.ok && identity.ats === "ashby" && !fields) return { ok: false, originalUrl, normalizedUrl, error: "POSTING_NOT_FOUND" };
  }
  if (Date.now() >= deadline) return { ok: false, originalUrl, normalizedUrl, error: "FETCH_TIMEOUT" };
  const page = await fetchPublicPosting(normalizedUrl, networkOptions());
  if (!page.ok) {
    if (!fields || page.error === "PRIVATE_NETWORK_BLOCKED") return { ok: false, originalUrl, normalizedUrl, error: page.error };
  }
  const pageFields = page.ok ? extractJobPosting(page.body, page.finalUrl) : {};
  if (pageFields.expired) return { ok: false, originalUrl, normalizedUrl, error: "POSTING_NOT_FOUND" };
  if (pageFields.ambiguousPosting) return { ok: false, originalUrl, normalizedUrl, error: "PARSE_FAILED" };
  if (page.ok && page.finalUrl) {
    let destination;
    try { destination = normalizeJobUrl(page.finalUrl); } catch { return { ok: false, originalUrl, normalizedUrl, error: "INVALID_URL" }; }
    const redirectedProvider = resolveAtsPosting(destination);
    const identityKey = value => value ? JSON.stringify([value.ats, value.tenant ?? value.site ?? value.org ?? null, value.id]) : null;
    if (identity && identityKey(identity) !== identityKey(redirectedProvider)) {
      if (!pageFields.company || !pageFields.role || !pageFields.jobDescription) return { ok: false, originalUrl, normalizedUrl, error: "POSTING_NOT_FOUND" };
      fields = null;
    }
    normalizedUrl = destination;
  }
  fields = { ...(fields ?? {}), ...Object.fromEntries(Object.entries(pageFields).map(([key, val]) => [key, val ?? fields?.[key] ?? null])) };
  if (!fields.company || !fields.role || !fields.jobDescription || fields.jobDescription.length < 80) {
    return { ok: false, originalUrl, normalizedUrl, error: "PARSE_FAILED" };
  }
  if (fields.jobDescription.length > 24_000) return { ok: false, originalUrl, normalizedUrl, error: "FETCH_TOO_LARGE" };
  return {
    ok: true, originalUrl, normalizedUrl, requestedNormalizedUrl,
    posting: {
      ...fields,
      jobDescription: fields.jobDescription,
      source: typeof source === "string" && source.trim() ? source.trim().slice(0, 500) : null,
      discoveredAt: new Date().toISOString(),
    },
  };
}
