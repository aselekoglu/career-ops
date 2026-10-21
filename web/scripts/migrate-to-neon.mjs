#!/usr/bin/env node

/**
 * Lossless, idempotent import of the local Career Ops user layer.
 *
 * The import deliberately stores the canonical source files as documents
 * first. This preserves markdown/TSV/YAML semantics while the application
 * adapter is migrated incrementally, and makes a second run safe: unchanged
 * files are no-ops and changed files are upserted by path.
 *
 * Secrets and machine state are excluded by the allowlist below. The script
 * never prints DATABASE_URL or document contents.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { neon } from "@neondatabase/serverless";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(decodeURIComponent(HERE), "../..");
const DEFAULT_ROOT = process.env.CAREER_OPS_ROOT?.trim() || REPO_ROOT;

const TEXT_FILES = [
  "cv.md",
  "cv-hospitality.md",
  "voice-dna.md",
  "modes/_profile.md",
  "config/profile.yml",
  "portals.yml",
  "data/applications.md",
  "data/pipeline.md",
  "data/scan-history.tsv",
  "data/scan-runs.tsv",
  "data/scan-scheduler-runs.tsv",
  "data/scan-scheduler-state.json",
  "data/scheduled-jobs.json",
  "data/pdf-index.tsv",
  "data/portal-health.tsv",
  "data/tracker-aliases.json",
];

const DATA_RE = /^data\/(?:applications\.md|pipeline\.md|scan-history\.tsv|scan-runs\.tsv|scan-scheduler-runs\.tsv|scan-scheduler-state\.json|scheduled-jobs\.json|pdf-index\.tsv|portal-health\.tsv|tracker-aliases\.json)$/i;
const SECRET_RE = /(\.env|secret|credential|token|password|api[-_]?key|private[-_]?key|cookie|session)/i;
const BINARY_EXT = new Set([".db", ".pdf", ".png", ".jpg", ".jpeg", ".webp", ".zip"]);

const DDL = `
CREATE TABLE IF NOT EXISTS career_ops_documents (
  path TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  content_encoding TEXT NOT NULL DEFAULT 'utf8',
  byte_size BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE career_ops_documents ADD COLUMN IF NOT EXISTS content_encoding TEXT NOT NULL DEFAULT 'utf8';
ALTER TABLE career_ops_documents ADD COLUMN IF NOT EXISTS byte_size BIGINT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS career_ops_documents_updated_idx ON career_ops_documents (updated_at DESC);
CREATE TABLE IF NOT EXISTS career_ops_imports (
  id BIGSERIAL PRIMARY KEY,
  source_root TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  document_count INTEGER NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "tmp" || entry.name === ".next") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function rel(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function shouldInclude(relative) {
  if (TEXT_FILES.includes(relative)) return true;
  if (DATA_RE.test(relative)) return true;
  if (/^reports\/.*\.md$/i.test(relative)) return true;
  if (/^\.career-ops-web\/runs\/.*\.md$/i.test(relative)) return true;
  if (/^output\/.*\.(pdf|html)$/i.test(relative)) return true;
  // Preserve the local SQLite snapshot as base64; the canonical Markdown is
  // still authoritative for current rows, while the DB retains legacy events.
  if (relative === "data/applications.db") return true;
  return false;
}

async function collectDocuments(root) {
  const files = await walk(root);
  const selected = files
    .map((file) => ({ file, relative: rel(root, file) }))
    .filter(({ relative }) => shouldInclude(relative) && !SECRET_RE.test(relative));
  const docs = [];
  for (const { file, relative } of selected) {
    const raw = await fs.readFile(file);
    const ext = path.extname(relative).toLowerCase();
    const binary = BINARY_EXT.has(ext);
    docs.push({
      path: relative,
      content: binary ? raw.toString("base64") : raw.toString("utf8"),
      encoding: binary ? "base64" : "utf8",
      byteSize: raw.byteLength,
      sha256: sha256(raw),
    });
  }
  docs.sort((a, b) => a.path.localeCompare(b.path));
  return docs;
}

function manifestHash(docs) {
  return sha256(Buffer.from(docs.map((d) => `${d.path}\t${d.sha256}\t${d.byteSize}\t${d.encoding}`).join("\n"), "utf8"));
}

function usage() {
  console.log("Usage: node web/scripts/migrate-to-neon.mjs [--root PATH] [--dry-run]");
  console.log("Uses DATABASE_URL_UNPOOLED for import, falling back to DATABASE_URL.");
}

if (hasFlag("--help") || hasFlag("-h")) {
  usage();
  process.exit(0);
}

const root = path.resolve(argValue("--root") || DEFAULT_ROOT);
const docs = await collectDocuments(root);
const manifest = manifestHash(docs);

console.log(JSON.stringify({ root, documentCount: docs.length, manifestSha256: manifest, paths: docs.map((d) => d.path) }, null, 2));

if (hasFlag("--dry-run")) process.exit(0);

const databaseUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Missing DATABASE_URL_UNPOOLED or DATABASE_URL; refusing to import.");
  process.exit(2);
}

const sql = neon(databaseUrl);
for (const statement of DDL.split(";").map((part) => part.trim()).filter(Boolean)) await sql.query(statement);
for (const doc of docs) {
  await sql`
    INSERT INTO career_ops_documents (path, content, sha256, content_encoding, byte_size, updated_at)
    VALUES (${doc.path}, ${doc.content}, ${doc.sha256}, ${doc.encoding}, ${doc.byteSize}, now())
    ON CONFLICT (path) DO UPDATE SET
      content = EXCLUDED.content,
      sha256 = EXCLUDED.sha256,
      content_encoding = EXCLUDED.content_encoding,
      byte_size = EXCLUDED.byte_size,
      updated_at = now()
    WHERE career_ops_documents.sha256 IS DISTINCT FROM EXCLUDED.sha256
  `;
}
await sql`
  INSERT INTO career_ops_imports (source_root, manifest_sha256, document_count)
  VALUES (${root}, ${manifest}, ${docs.length})
`;

const check = await sql`SELECT count(*)::int AS count FROM career_ops_documents`;
const imported = Number(check[0]?.count ?? -1);
if (imported < docs.length) throw new Error(`verification failed: expected at least ${docs.length} documents, found ${imported}`);
console.log(JSON.stringify({ ok: true, importedDocuments: docs.length, storedDocuments: imported, manifestSha256: manifest }));
