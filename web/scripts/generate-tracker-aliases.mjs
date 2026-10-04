#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.resolve(HERE, "../../tracker-aliases.json");
const OUTPUT = path.resolve(HERE, "../src/lib/tracker-aliases.generated.mjs");
const FIELDS = new Set(["num", "date", "company", "via", "role", "location", "score", "status", "pdf", "report", "notes"]);

let aliases;
try { aliases = JSON.parse(fs.readFileSync(SOURCE, "utf8")); }
catch { throw new Error("Could not read canonical tracker-aliases.json"); }
if (!aliases || typeof aliases !== "object" || Array.isArray(aliases) || !Object.keys(aliases).length ||
    Object.entries(aliases).some(([alias, field]) => !alias.trim() || typeof field !== "string" || !FIELDS.has(field))) {
  throw new Error("Canonical tracker-aliases.json has an invalid shape");
}

const output = `// Generated from tracker-aliases.json by web/scripts/generate-tracker-aliases.mjs.\nexport const BUNDLED_TRACKER_ALIASES = Object.freeze(${JSON.stringify(aliases, null, 2)});\n`;
fs.writeFileSync(OUTPUT, output, "utf8");
