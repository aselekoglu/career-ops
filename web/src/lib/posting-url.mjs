/** Posting URL extraction shared by the hosted tracker read path. */

function unescapeDestination(text) {
  return text.replace(/\\([\\()<> ])/g, "$1");
}

function linkDestination(raw) {
  const value = String(raw).trimStart();
  if (value.startsWith("<")) {
    for (let i = 1; i < value.length; i++) {
      if (value[i] === "\\") i++;
      else if (value[i] === ">") return unescapeDestination(value.slice(1, i));
    }
    return null;
  }
  let depth = 0;
  let end = value.length;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "\\") { i++; continue; }
    if (value[i] === "(") depth++;
    else if (value[i] === ")" && depth > 0) depth--;
    else if (/\s/.test(value[i]) && depth === 0) { end = i; break; }
  }
  const destination = value.slice(0, end).trim();
  return destination ? unescapeDestination(destination) : null;
}

function firstHttpMarkdownTarget(value) {
  let cursor = 0;
  while (cursor < value.length) {
    const labelStart = value.indexOf("[", cursor);
    if (labelStart === -1) return null;
    let labelEnd = -1;
    for (let i = labelStart + 1; i < value.length; i++) {
      if (value[i] === "\\") i++;
      else if (value[i] === "]") { labelEnd = i; break; }
    }
    if (labelEnd === -1 || value[labelEnd + 1] !== "(") { cursor = labelStart + 1; continue; }
    let depth = 1;
    let linkEnd = -1;
    for (let i = labelEnd + 2; i < value.length; i++) {
      if (value[i] === "\\") i++;
      else if (value[i] === "(") depth++;
      else if (value[i] === ")" && --depth === 0) { linkEnd = i; break; }
    }
    if (linkEnd === -1) { cursor = labelStart + 1; continue; }
    const target = linkDestination(value.slice(labelEnd + 2, linkEnd));
    const href = target == null ? "" : String(target).trim().replace(/^<|>$/g, "");
    if (/^https?:\/\//i.test(href)) return href;
    cursor = linkEnd + 1;
  }
  return null;
}

/** Markdown links return their HTTP(S) href; other cells remain trimmed text. */
export function readTrackerUrl(cell) {
  const value = String(cell ?? "").trim();
  if (!value) return "";
  return firstHttpMarkdownTarget(value) ?? value;
}
