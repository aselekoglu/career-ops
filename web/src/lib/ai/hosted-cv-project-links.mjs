const SOURCE_URL = /https?:\/\/[^\s<>"')\]]+/gi;
const SOURCE_EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SOURCE_PHONE = /\+?\d[\d\s().-]{5,}\d/g;
const PROJECT_LINK_BLOCK = /<div\b[^>]*\bclass\s*=\s*(["'])[^"']*\bproject-link\b[^"']*\1[^>]*>([\s\S]*?)<\/div>/gi;
const CONTACT_ROW = /<div\b(?=[^>]*\bclass\s*=\s*(["'])[^"']*\bcontact-row\b[^"']*\1)[^>]*>[\s\S]*?<\/div>/gi;

function decodeHtml(value) {
  // One replacement pass preserves double-encoded text instead of recursively
  // turning it into markup or a different URL before the value is escaped.
  return String(value).replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/gi, (entity) => {
    switch (entity.toLowerCase()) {
      case "&amp;": return "&";
      case "&lt;": return "<";
      case "&gt;": return ">";
      case "&quot;": return '"';
      case "&#39;":
      case "&apos;": return "'";
      case "&nbsp;": return " ";
      default: return entity;
    }
  });
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

function sourceWebUrls(sourceCv) {
  const urls = new Set();
  for (const raw of String(sourceCv || "").match(SOURCE_URL) || []) {
    const candidate = decodeHtml(raw).trim().replace(/[.,;:!?]+$/g, "");
    try {
      const url = new URL(candidate);
      if (["https:", "http:"].includes(url.protocol) && url.hostname && !url.username && !url.password) {
        urls.add(url.href);
      }
    } catch {
      // A malformed URL in the CV is not an allowlisted contact target.
    }
  }
  return urls;
}

function normalizeContactHref(raw, sourceCv) {
  const candidate = decodeHtml(raw).trim();
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const url = new URL(candidate);
      return sourceWebUrls(sourceCv).has(url.href) ? url.href : null;
    } catch {
      return null;
    }
  }
  if (/^mailto:/i.test(candidate)) {
    const email = candidate.slice(7).split(/[?#]/, 1)[0].trim().toLowerCase();
    const sourceEmails = String(sourceCv || "").match(SOURCE_EMAIL) || [];
    return sourceEmails.some((item) => item.toLowerCase() === email) ? `mailto:${email}` : null;
  }
  if (/^tel:/i.test(candidate)) {
    const number = candidate.slice(4).trim();
    if (!/^\+?[\d\s().-]+$/.test(number)) return null;
    const digits = number.replace(/\D/g, "");
    if (digits.length < 7) return null;
    const sourceNumbers = String(sourceCv || "").split(/\r?\n/).flatMap((line) => line.match(SOURCE_PHONE) || []);
    return sourceNumbers.some((item) => item.replace(/\D/g, "") === digits)
      ? `tel:${number.startsWith("+") ? "+" : ""}${digits}`
      : null;
  }
  return null;
}

function sanitizeContactRow(row, sourceCv) {
  return row
    .replace(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_anchor, _quote, rawHref, labelMarkup) => {
      const href = normalizeContactHref(rawHref, sourceCv);
      const label = visibleText(labelMarkup);
      return href && label
        ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`
        : escapeHtml(label);
    });
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
  const protectedParts = [];
  const protect = (value) => {
    let token = `\u0000CAREER_OPS_CV_PART_${protectedParts.length}\u0000`;
    while (html.includes(token)) token += "_";
    protectedParts.push([token, value]);
    return token;
  };

  let result = html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, protect)
    .replace(CONTACT_ROW, (row) => protect(sanitizeContactRow(row, sourceCv)))
    .replace(PROJECT_LINK_BLOCK, (_block, _quote, inner) => {
      const safe = safeProjectLink(inner, allowedUrls);
      return safe ? protect(safe) : "";
    })
    // The hosted template exposes candidate links only in the header contact
    // row and in project-link blocks. Strip other anchors and href attributes
    // globally so comments or section reshaping cannot bypass the allowlist.
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1")
    .replace(/\s+href\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  for (const [token, value] of protectedParts) result = result.split(token).join(value);
  return result;
}
