export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SCAN_INPUT_SCHEMA = { type: 'object', properties: {
  mode: { type: 'string', enum: ['portals'], default: 'portals' },
  companies: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 160 } },
  sinceDays: { type: 'integer', minimum: 1, maximum: 30, default: 5 },
  query: { type: 'string', maxLength: 160 }, limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
}, additionalProperties: false };

export function validateScanInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !(k in SCAN_INPUT_SCHEMA.properties))) throw new Error('Invalid scan request fields.');
  const value = { mode: input.mode ?? 'portals', sinceDays: input.sinceDays ?? 5, limit: input.limit ?? 50 };
  if (value.mode !== 'portals' || !Number.isInteger(value.sinceDays) || value.sinceDays < 1 || value.sinceDays > 30 || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 500) throw new Error('Only portals scans, sinceDays 1..30 and limit 1..500 are supported.');
  if (input.query !== undefined) { if (typeof input.query !== 'string' || input.query.length > 160) throw new Error('Invalid query.'); value.query = input.query; }
  if (input.companies !== undefined) {
    if (!Array.isArray(input.companies) || !input.companies.length || input.companies.length > 100 || input.companies.some(s => typeof s !== 'string' || !s.trim() || s.length > 160 || s.includes('://'))) throw new Error('Invalid configured company names.');
    value.companies = [...new Set(input.companies.map(s => s.trim()))];
  }
  return value;
}

export function selectScanConfig(config, request) {
  const enabled = (config.tracked_companies ?? []).filter(c => c && c.enabled !== false && typeof c.name === 'string');
  const names = request.companies?.map(s => s.toLowerCase());
  if (names?.some(n => !enabled.some(c => c.name.toLowerCase() === n))) throw new Error('Company is not an enabled configured portal.');
  const selected = names ? enabled.filter(c => names.includes(c.name.toLowerCase())) : enabled;
  if (!selected.length) throw new Error('No enabled configured portals.');
  if (!Array.isArray(config.title_filter?.positive) || !config.title_filter.positive.length) throw new Error('Configured title filters are required.');
  // Local parser commands remain opt-in trusted config, never MCP input.
  return { ...config, tracked_companies: selected, job_boards: [] };
}

export function validateReceipt(receipt) {
  if (!receipt || receipt.version !== 'careerops.scan.live@1' || !Array.isArray(receipt.jobs) || receipt.jobs.length > 5000 || !Array.isArray(receipt.sources) || !Array.isArray(receipt.errors)) throw new Error('Invalid scanner receipt.');
  if (!Number.isFinite(Date.parse(receipt.startedAt)) || !Number.isFinite(Date.parse(receipt.completedAt)) || Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt)) throw new Error('Invalid scan timestamps.');
  for (const job of receipt.jobs) {
    if (!job || typeof job.company !== 'string' || typeof job.title !== 'string' || typeof job.url !== 'string' || job.url.length > 3000 || /[\s|\u0000-\u001f\u007f]/u.test(job.url)) throw new Error('Invalid job.');
    const url = new URL(job.url); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid source URL.');
  }
  return receipt;
}

export function buildLiveResult(raw, request) {
  const receipt = validateReceipt(raw), sinceMs = Date.parse(receipt.startedAt) - request.sinceDays * 86400000;
  const seen = new Set(), jobs = [], unknownJobs = [];
  for (const row of receipt.jobs) {
    if (seen.has(row.url)) continue; seen.add(row.url);
    if (request.query && !(row.company + ' ' + row.title).toLowerCase().includes(request.query.toLowerCase())) continue;
    const reported = typeof row.postedAt === 'number' && Number.isFinite(row.postedAt) && row.postedAt <= Date.parse(receipt.completedAt);
    if (reported && row.postedAt < sinceMs) continue;
    const job = { company: row.company, role: row.title, location: row.location ?? '', url: row.url, source: row.source ?? 'unknown',
      postedAt: reported ? new Date(row.postedAt).toISOString() : null,
      postedAtStatus: reported ? (row.postedAtPrecision === 'day' ? 'ats-reported-day' : 'ats-reported') : 'unknown',
      postedAtEvidence: row.postedAtEvidence ?? null,
      discoveredAt: row.known ? null : receipt.startedAt, lastSeenAt: receipt.completedAt, newlyDiscovered: !row.known };
    (reported ? jobs : unknownJobs).push(job);
  }
  const failed = receipt.sources.filter(s => s.status === 'failed');
  const attempted = receipt.sources.filter(s => s.status !== 'unsupported');
  return { status: !attempted.length || failed.length === attempted.length ? 'failed' : failed.length || receipt.sources.some(s => s.status === 'unsupported') ? 'partial' : 'completed',
    fresh: true, storage: 'live-scan', scanMode: 'portals', startedAt: receipt.startedAt, completedAt: receipt.completedAt,
    sinceDays: request.sinceDays, companiesScanned: attempted.length, sourcesFailed: failed.length, sourcesSkipped: receipt.sources.length - attempted.length,
    sources: receipt.sources, errors: receipt.errors, jobsInspected: receipt.found ?? 0,
    jobsMatched: jobs.length + unknownJobs.length, newJobs: [...jobs, ...unknownJobs].filter(j => j.newlyDiscovered).length,
    verifiedRecentJobs: jobs.length, unknownPostedAt: unknownJobs.length, jobs, unknownJobs };
}

const cell = value => String(value ?? '').replace(/[\r\n|]/g, ' ').trim();
export function pipelineAdditions(prior, result) {
  const urls = new Set((prior.match(/https?:\/\/[^\s|]+/g) ?? []));
  const additions = [];
  for (const job of [...result.jobs, ...result.unknownJobs]) {
    if (!job.newlyDiscovered || urls.has(job.url)) continue;
    urls.add(job.url);
    additions.push('- [ ] ' + [job.url, cell(job.company), cell(job.role), cell(job.location), 'posted: ' + (job.postedAt?.slice(0, 10) ?? 'unknown'), 'discovered: ' + job.discoveredAt, 'last_seen: ' + job.lastSeenAt, 'source: ' + cell(job.source)].join(' | '));
  }
  return { newJobs: additions.length, content: additions.length ? prior.replace(/\s*$/, '') + '\n' + additions.join('\n') + '\n' : prior };
}
