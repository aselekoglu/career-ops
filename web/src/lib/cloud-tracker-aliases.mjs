import { BUNDLED_TRACKER_ALIASES } from "./tracker-aliases.generated.mjs";

const FIELDS = new Set(["num", "date", "company", "via", "role", "location", "score", "status", "pdf", "report", "notes"]);

function validate(value, errorCode) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length ||
      Object.entries(value).some(([alias, field]) => !alias.trim() || typeof field !== "string" || !FIELDS.has(field))) {
    throw new Error(errorCode);
  }
  return value;
}

/** Resolve an optional Neon alias document against the generated canonical source. */
export function resolveTrackerAliases(content, errorCode = "TRACKER_ALIASES_INVALID") {
  if (content == null) return BUNDLED_TRACKER_ALIASES;
  let parsed = content;
  if (typeof content === "string") {
    try { parsed = JSON.parse(content); } catch { throw new Error(errorCode); }
  }
  return validate(parsed, errorCode);
}
