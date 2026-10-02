#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

const API = 'https://career-ops-aselekoglu.vercel.app/api/evaluation-worker';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCEPTED_STATUSES = new Set(['completed', 'failed', 'running']);

export async function triggerEvaluationWorker({
  id = process.env.EVALUATION_ID,
  secret = process.env.CAREER_OPS_SCAN_WORKER_SECRET,
  fetchFn = fetch,
} = {}) {
  if (!UUID_RE.test(id ?? '') || !secret) throw new Error('WORKER_CONFIGURATION_INVALID');

  const response = await fetchFn(API, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(330_000),
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ evaluationId: id }),
  });
  if (!response.ok) throw new Error('WORKER_CALLBACK_FAILED');

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('INVALID_WORKER_RESPONSE');
  }
  if (!result || !ACCEPTED_STATUSES.has(result.status)) throw new Error('INVALID_WORKER_RESPONSE');
  if (result.runId !== undefined && result.runId !== id) throw new Error('INVALID_WORKER_RESPONSE');
  if (result.status === 'failed') throw new Error('EVALUATION_FAILED');

  console.log(JSON.stringify({ runId: result.runId ?? id, status: result.status }));
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  triggerEvaluationWorker().catch((error) => {
    console.error(`Cloud evaluation worker failed: ${error.message}`);
    process.exitCode = 1;
  });
}
