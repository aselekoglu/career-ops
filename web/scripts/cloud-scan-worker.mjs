#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { UUID_RE, validateReceipt } from '../src/lib/live-scan-contract.mjs';

const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API = 'https://career-ops-aselekoglu.vercel.app/api/scan-worker';
const ALLOWED_INPUTS = new Set(['portals.yml','config/profile.yml','data/applications.md','data/pipeline.md','data/scan-history.tsv','data/blacklist.md']);
export function readScannerReceipt(stdout) {
  const lines = stdout.trim().split(/\r?\n/);
  const last = lines.at(-1);
  return validateReceipt(JSON.parse(last));
}

export async function runScanner(root, sinceDays, spawnFn = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(process.execPath, [path.join(CODE_ROOT, 'scan.mjs'),'--dry-run','--json','--since',String(sinceDays),'--quiet'], {
      // This deployed core version still resolves some data files from cwd.
      // Providers themselves resolve code from import.meta.url.
      cwd: root, env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_DATA_DIR: root,
        CAREER_OPS_PORTALS: path.join(root,'portals.yml'), CAREER_OPS_PROFILE: path.join(root,'config/profile.yml'),
        CAREER_OPS_PIPELINE: path.join(root,'data/pipeline.md'), CAREER_OPS_SCAN_HISTORY: path.join(root,'data/scan-history.tsv'),
        CAREER_OPS_TRACKER: path.join(root,'data/applications.md') },
      stdio: ['ignore','pipe','pipe'], windowsHide: true,
    });
    let stdout = '', size = 0, settled = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('SCANNER_TIMEOUT')); }, 25 * 60 * 1000);
    function finish(error, receipt) { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(receipt); }
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
      size += Buffer.byteLength(chunk); if (size > 8_000_000) { child.kill('SIGKILL'); finish(new Error('SCANNER_OUTPUT_LIMIT')); } else stdout += chunk;
    });
    // Scanner logs may contain private configuration. Never stream them into GitHub's public logs.
    child.stderr.on('data', () => {});
    child.once('error', () => finish(new Error('SCANNER_START_FAILED')));
    child.once('close', code => {
      if (code !== 0) return finish(new Error('SCANNER_FAILED'));
      try { finish(null, readScannerReceipt(stdout)); } catch { finish(new Error('INVALID_SCANNER_RECEIPT')); }
    });
  });
}

export async function runCloudWorker({ id = process.env.SCAN_ID, secret = process.env.CAREER_OPS_SCAN_WORKER_SECRET, failOnly = false, fetchFn = fetch, scanner = runScanner } = {}) {
  if (!UUID_RE.test(id ?? '') || !secret) throw new Error('WORKER_CONFIGURATION_INVALID');
  async function callback(action, extra = {}) {
    const response = await fetchFn(API, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, scanId: id, ...extra }) });
    if (action === 'claim' && response.status === 409) throw new Error('SCAN_NOT_CLAIMABLE');
    if (!response.ok) throw new Error('WORKER_CALLBACK_FAILED'); return response.json();
  }
  if (failOnly) return callback('fail');
  let root, lease = null;
  try {
    const claim = await callback('claim');
    if (!UUID_RE.test(claim.lease ?? '') || !claim.documents || typeof claim.request?.sinceDays !== 'number') throw new Error('INVALID_WORKER_CLAIM');
    lease = claim.lease;
    root = await fs.mkdtemp(path.join(os.tmpdir(),'career-ops-cloud-scan-'));
    for (const [name, content] of Object.entries(claim.documents)) {
      if (!ALLOWED_INPUTS.has(name) || typeof content !== 'string' || Buffer.byteLength(content) > 2_000_000) throw new Error('INVALID_WORKER_DOCUMENT');
      const filename = path.join(root,name); await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename,content);
    }
    const receipt = await scanner(root,claim.request.sinceDays);
    const result = await callback('complete', { lease: claim.lease, receipt });
    console.log(JSON.stringify({ scanId:id, status:result.status, jobsInspected:result.jobsInspected, jobsMatched:result.jobsMatched, newJobs:result.newJobs }));
    return result;
  } catch (error) {
    if (error.message !== 'SCAN_NOT_CLAIMABLE') {
      try { await callback('fail', { lease }); } catch { /* status polling expires an orphaned run */ }
    }
    throw error;
  }
  finally { if (root) await fs.rm(root, { recursive: true, force: true }); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCloudWorker({ failOnly: process.argv.includes('--fail') }).catch(() => { console.error('Cloud scan worker failed. See the scan status API for its durable state.'); process.exitCode = 1; });
}
