export const PORTFOLIO_DOCUMENT_SCHEMA_VERSION = "careerops.portfolio.document@1";
export const MAX_PORTFOLIO_DOCUMENT_BYTES = 128 * 1024;
export const MAX_PORTFOLIO_PROJECTS = 10;
export const MAX_PORTFOLIO_RENDERED_PAGES = 12;

export class PortfolioDocumentError extends Error {
  constructor(code) { super(code); this.name = "PortfolioDocumentError"; }
}

const fail = (key) => { throw new PortfolioDocumentError(`PORTFOLIO_DOCUMENT_${key}_INVALID`); };
function text(value, key, max, {optional=false}={}) {
  if (value === undefined && optional) return "";
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(key);
  return value.trim();
}
function strings(value, key, maxItems, maxLength) {
  if (!Array.isArray(value) || value.length > maxItems) fail(key);
  return value.map((v) => text(v, key, maxLength));
}
function links(value, key) {
  if (!Array.isArray(value) || value.length > 24) fail(key);
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail(key);
    const label = text(item.label, key, 100);
    const url = text(item.url, key, 1000);
    let parsed;
    try { parsed = new URL(url); } catch { fail(key); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) fail(key);
    return { label, url };
  });
}

export function normalizePortfolioDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("SHAPE");
  if (value.schemaVersion !== undefined && value.schemaVersion !== PORTFOLIO_DOCUMENT_SCHEMA_VERSION) fail("SCHEMA");
  const projects = value.projects ?? [];
  if (!Array.isArray(projects) || projects.length > MAX_PORTFOLIO_PROJECTS) fail("PROJECTS");
  const document = {
    schemaVersion: PORTFOLIO_DOCUMENT_SCHEMA_VERSION,
    name: text(value.name, "NAME", 160),
    headline: text(value.headline, "HEADLINE", 240),
    summary: text(value.summary, "SUMMARY", 5000),
    highlights: strings(value.highlights ?? [], "HIGHLIGHTS", 16, 500),
    projects: projects.map((project) => {
      if (!project || typeof project !== "object" || Array.isArray(project)) fail("PROJECT");
      return {
        title: text(project.title, "PROJECT", 200),
        role: text(project.role ?? "", "PROJECT", 200),
        summary: text(project.summary ?? "", "PROJECT", 2000),
        highlights: strings(project.highlights ?? [], "PROJECT_HIGHLIGHTS", 8, 500),
        skills: strings(project.skills ?? [], "PROJECT_SKILLS", 32, 100),
        links: links(project.links ?? [], "PROJECT_LINKS"),
      };
    }),
    skills: strings(value.skills ?? [], "SKILLS", 64, 100),
    links: links(value.links ?? [], "LINKS"),
  };
  if (value.theme !== undefined) {
    if (!['classic', 'editorial'].includes(value.theme)) fail("THEME");
    document.theme = value.theme;
  }
  if (new TextEncoder().encode(JSON.stringify(document)).byteLength > MAX_PORTFOLIO_DOCUMENT_BYTES) fail("SIZE");
  return document;
}

const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const list = (items) => items.length ? `<ul>${items.map(item => `<li>${esc(item)}</li>`).join("")}</ul>` : "";
const linkList = (items) => items.length ? `<ul>${items.map(({label,url}) => `<li><a href="${esc(url)}" rel="noreferrer">${esc(label)}</a></li>`).join("")}</ul>` : "";

/** Render trusted, normalized portfolio data to fixed deterministic HTML. */
export function renderPortfolioDocument(value, {format="letter"}={}) {
  const document = normalizePortfolioDocument(value);
  if (!['letter', 'a4'].includes(format)) fail("FORMAT");
  const projects = document.projects.map(project => `<section class="project"><h3>${esc(project.title)}</h3>${project.role ? `<p class="role">${esc(project.role)}</p>` : ""}${project.summary ? `<p>${esc(project.summary)}</p>` : ""}${list(project.highlights)}${project.skills.length ? `<p class="skills">${esc(project.skills.join(" · "))}</p>` : ""}${linkList(project.links)}</section>`).join("");
  const theme=document.theme||'classic';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(document.name)} — Portfolio</title><style>@page{size:${format};margin:18mm}*{box-sizing:border-box}body{font:10.5pt/1.5 Arial,Helvetica,sans-serif;color:#202833;max-width:760px;margin:0 auto}h1{font-size:27pt;line-height:1.1;margin:0}h2{font-size:13pt;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid #9aa5b1;padding-bottom:4px;margin:24px 0 9px}h3{font-size:13pt;margin:0 0 3px}.headline{font-size:13pt;color:#526171;margin:7px 0 18px}.role,.skills{color:#526171}p{margin:5px 0 9px}ul{margin:6px 0 10px;padding-left:20px}li{margin:2px 0}.project{break-inside:avoid;margin:12px 0 18px}a{color:#174f83;text-decoration:none}.theme-editorial body{font-family:Georgia,'Times New Roman',serif;color:#262722}.theme-editorial h1{font-size:31pt;letter-spacing:-.035em}.theme-editorial h2{color:#704f35;border-color:#b9a48d;text-transform:none;letter-spacing:.03em}</style></head><body class="theme-${theme}"><header><h1>${esc(document.name)}</h1>${document.headline ? `<p class="headline">${esc(document.headline)}</p>` : ""}</header>${document.summary ? `<section><h2>Profile</h2><p>${esc(document.summary)}</p></section>` : ""}${document.highlights.length ? `<section><h2>Highlights</h2>${list(document.highlights)}</section>` : ""}${projects ? `<section><h2>Selected Projects</h2>${projects}</section>` : ""}${document.skills.length ? `<section><h2>Skills</h2><p>${esc(document.skills.join(" · "))}</p></section>` : ""}${document.links.length ? `<section><h2>Links</h2>${linkList(document.links)}</section>` : ""}</body></html>`;
}
