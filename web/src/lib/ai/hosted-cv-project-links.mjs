const SOURCE_URL = /https:\/\/[^\s<>"')\]]+/gi;
const PROJECT_LINK_BLOCK = /<div\b[^>]*\bclass\s*=\s*(["'])[^"']*\bproject-link\b[^"']*\1[^>]*>([\s\S]*?)<\/div>/gi;
const CONTACT_ROW = /<div\b(?=[^>]*\bclass\s*=\s*(["'])[^"']*\bcontact-row\b[^"']*\1)[^>]*>[\s\S]*?<\/div>/gi;

function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

function normalizeProjectUrl(raw) {
  const candidate = decodeHtml(raw).trim().replace(/[.,;:!?]+$/g, "");
  if (!/^https:\/\//i.test(candidate)) return null;

  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function sourceProjectUrls(sourceCv) {
  const lines = String(sourceCv || "").split(/\r?\n/);
  const projectLines = [];
  let sectionLevel = 0;

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      if (sectionLevel) {
        if (level > sectionLevel) continue;
        sectionLevel = 0;
      }
      if (/\bprojects\b|\bproject portfolio\b/i.test(heading[2])) {
        sectionLevel = level;
        continue;
      }
      continue;
    }
    if (sectionLevel) projectLines.push(line);
  }

  const urls = new Set();
  for (const match of projectLines.join("\n").matchAll(SOURCE_URL)) {
    const url = normalizeProjectUrl(match[0]);
    if (url) urls.add(url);
  }
  return urls;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function visibleText(markup) {
  return decodeHtml(String(markup).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function safeProjectLink(inner, allowedUrls) {
  const anchor = inner.trim().match(/^<a\s+href\s*=\s*(["'])(.*?)\1\s*>([\s\S]*?)<\/a>$/i);
  if (!anchor) return "";

  const url = normalizeProjectUrl(anchor[2]);
  const label = visibleText(anchor[3]);
  if (!url || !allowedUrls.has(url) || !label) return "";

  return `<div class="project-link"><a href="${escapeHtml(url)}">${escapeHtml(label)}</a></div>`;
}

/**
 * Keep hosted project links only when the HTTPS URL is present in the source
 * CV's Projects section. Contact links are preserved; other model-generated
 * anchors are reduced to their visible text.
 */
export function sanitizeHostedProjectLinks(html, sourceCv) {
  if (typeof html !== "string") return html;

  const allowedUrls = sourceProjectUrls(sourceCv);
  const sanitizeRegion = (region) => {
    const protectedLinks = [];
    const protect = (value) => {
      let token = `\u0000CAREER_OPS_PROJECT_LINK_${protectedLinks.length}\u0000`;
      while (region.includes(token)) token += "_";
      protectedLinks.push([token, value]);
      return token;
    };

    let result = region
      .replace(PROJECT_LINK_BLOCK, (_block, _quote, inner) => {
        const safe = safeProjectLink(inner, allowedUrls);
        return safe ? protect(safe) : "";
      })
      .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1")
      .replace(/\s+href\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

    for (const [token, value] of protectedLinks) result = result.split(token).join(value);
    return result;
  };

  const start = html.indexOf("<!-- PROJECTS -->");
  const end = start < 0 ? -1 : html.indexOf("<!-- EDUCATION -->", start + "<!-- PROJECTS -->".length);
  if (start >= 0 && end > start) {
    return html.slice(0, start)
      + sanitizeRegion(html.slice(start, end))
      + html.slice(end);
  }

  // If the model drops the template markers while keeping project markup,
  // fail closed for non-contact links. A template with no project section is
  // valid and does not need rewriting.
  if (!/\bclass\s*=\s*(["'])[^"']*\bprojects?\b[^"']*\1/i.test(html)) return html;

  const protectedParts = [];
  const protect = (value) => {
    let token = `\u0000CAREER_OPS_CV_PART_${protectedParts.length}\u0000`;
    while (html.includes(token)) token += "_";
    protectedParts.push([token, value]);
    return token;
  };
  let result = html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, protect)
    .replace(CONTACT_ROW, protect);
  result = sanitizeRegion(result);
  for (const [token, value] of protectedParts) result = result.split(token).join(value);
  return result;
}
