#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalSourceBytes } from './canonical-source-bytes.mjs';

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/lib/canonical-fact-gate');
const EXPECTED = new Set(['verify-cv-facts.mjs', 'lib/is-main-module.mjs', 'path-resolver.mjs']);
const fail = (reason) => { throw new Error(`Canonical web fact gate package is invalid: ${reason}`); };
let manifest;
try { manifest = JSON.parse(readFileSync(path.join(PACKAGE, 'manifest.json'), 'utf8')); }
catch { fail('manifest missing or invalid'); }
if (!manifest || !manifest.files || Object.keys(manifest.files).length !== EXPECTED.size) fail('manifest file list is incomplete');
for (const entry of Object.values(manifest.files)) {
  if (!entry || !EXPECTED.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256 || '')) fail('manifest entry is invalid');
  const filePath = path.resolve(PACKAGE, entry.path);
  if (!filePath.startsWith(`${PACKAGE}${path.sep}`)) fail('manifest path escapes package');
  let bytes;
  try { bytes = readFileSync(filePath); }
  catch { fail(`packaged file missing: ${entry.path}`); }
  const actual = createHash('sha256').update(canonicalSourceBytes(bytes.toString('utf8'))).digest('hex');
  if (actual !== entry.sha256) fail(`packaged file hash mismatch: ${entry.path}`);
}
for (const required of EXPECTED) {
  if (!Object.values(manifest.files).some((entry) => entry.path === required)) fail(`manifest entry missing: ${required}`);
}
