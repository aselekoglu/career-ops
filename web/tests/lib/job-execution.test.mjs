import assert from "node:assert/strict";
import test from "node:test";

const { getExecutionCapabilities, isLocalCliConfigured, getJobAvailability, getHostedStartRequest, hostedEvaluationIdempotencyKey, importJobForHostedEvaluation, startHostedRun, pollHostedRun, cvArtifactDownloadPath, reserveHostedStart, releaseHostedStart, projectPersistedJob, persistJobsSnapshot, persistHostedJobSnapshot, restorePersistedJobs } =
  await import(new URL("../../src/lib/job-execution.mjs", import.meta.url));
const { advanceShortlistBatch, createShortlistBatch, parseShortlistBatch, persistShortlistBatch, readShortlistBatch, resolveShortlistBatchActiveJob } =
  await import(new URL("../../src/lib/shortlist-batch.mjs", import.meta.url));

test("execution capabilities distinguish hosted readiness, local runtime and unknown status", () => {
  assert.deepEqual(getExecutionCapabilities({ runtime: "vercel", evaluations: { available: true }, cvGeneration: { available: false } }), {
    mode: "hosted", evaluationsAvailable: true, cvGenerationAvailable: false,
  });
  assert.deepEqual(getExecutionCapabilities({ runtime: "local" }), { mode: "local", evaluationsAvailable: false, cvGenerationAvailable: false });
  assert.deepEqual(getExecutionCapabilities({ status: "ok" }), { mode: "unknown", evaluationsAvailable: false, cvGenerationAvailable: false });
});

test("local CLI availability reflects saved config changes and fails closed on malformed config", () => {
  assert.equal(isLocalCliConfigured(null), false);
  assert.equal(isLocalCliConfigured("{}"), false);
  assert.equal(isLocalCliConfigured('{"cliId":"claude"}'), true);
  assert.equal(isLocalCliConfigured("not-json"), false);
});

test("confirmed hosted shortlist batches persist exact targets and advance one success at a time", () => {
  const items = [
    { url: "https://jobs.example/1", company: "One", role: "Role 1" },
    { url: "https://jobs.example/2", company: "Two", role: "Role 2" },
  ];
  const batch = createShortlistBatch(items, "shortlist-test");
  assert.equal(batch.nextIndex, 0);
  const next = advanceShortlistBatch({ ...batch, activeJobId: "job-1" });
  assert.equal(next.nextIndex, 1);
  assert.equal(next.activeJobId, null);
  assert.equal(next.items[0].url, items[0].url);
  assert.equal(advanceShortlistBatch({ ...next, activeJobId: "job-2" }), null);
  assert.deepEqual(resolveShortlistBatchActiveJob({ ...batch, activeJobId: "job-1" }, [], false), { state: "loading", job: null });
  assert.deepEqual(resolveShortlistBatchActiveJob({ ...batch, activeJobId: "job-1" }, [], true), { state: "missing", job: null });
  assert.deepEqual(resolveShortlistBatchActiveJob({ ...batch, activeJobId: "job-1" }, [{ id: "job-1", status: "running" }], true), { state: "found", job: { id: "job-1", status: "running" } });

  const memory = new Map();
  const storage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: (key) => memory.delete(key) };
  assert.equal(persistShortlistBatch(storage, { ...batch, activeJobId: "job-1" }), true);
  assert.deepEqual(readShortlistBatch(storage), { ...batch, activeJobId: "job-1" });
  assert.deepEqual(parseShortlistBatch('{"batchId":"bad","items":[],"nextIndex":3,"activeJobId":null}'), null);
  assert.equal(persistShortlistBatch(storage, null), true);
  assert.equal(readShortlistBatch(storage), null);
});

test("hosted availability is disabled while readiness is unknown or for unsupported job kinds", () => {
  assert.equal(getJobAvailability("evaluate", { mode: "unknown" }, true).available, false);
  assert.equal(getJobAvailability("evaluate", { mode: "hosted", evaluationsAvailable: false }).available, false);
  assert.match(getJobAvailability("research", { mode: "hosted", evaluationsAvailable: true }).reason, /local CLI/);
  assert.equal(getJobAvailability("evaluate", { mode: "local" }, true).available, true);
});

test("same-target hosted starts reserve synchronously so rapid clicks share one job", () => {
  const reservations = new Map();
  const first = reserveHostedStart(reservations, "pdf:77", "job-a");
  const second = reserveHostedStart(reservations, "pdf:77", "job-b");
  assert.deepEqual(first, { id: "job-a", created: true });
  assert.deepEqual(second, { id: "job-a", created: false });
  releaseHostedStart(reservations, "pdf:77", "job-b");
  assert.equal(reservations.get("pdf:77"), "job-a");
  releaseHostedStart(reservations, "pdf:77", "job-a");
  assert.equal(reservations.has("pdf:77"), false);
});

test("hosted job persistence keeps resumable run IDs and unknown markers but never stores hosted output", () => {
  const active = { id: "job-a", backend: "hosted", kind: "evaluate", input: "https://jobs.example/role", status: "running", runId: "55555555-5555-4555-8555-555555555555", steps: [], text: "private report text" };
  const projected = projectPersistedJob(active);
  assert.equal(projected.runId, active.runId);
  assert.equal(projected.text, "");
  assert.ok(!JSON.stringify(projected).includes("private report text"));

  const restored = restorePersistedJobs([active, { id: "job-b", backend: "hosted", kind: "pdf", input: "77", status: "running", steps: [], text: "private CV text" }], 123);
  assert.equal(restored[0].status, "running");
  assert.equal(restored[0].runId, active.runId);
  assert.equal(restored[1].status, "error");
  assert.equal(restored[1].startOutcome, "unknown");
  assert.equal(restored[1].text, "");
  assert.ok(!JSON.stringify(restored).includes("private CV text"));
});

test("hosted dispatch requires a synchronously persisted safety snapshot", async () => {
  const records = new Map();
  const storage = { setItem: (key, value) => records.set(key, value) };
  const target = "https://jobs.example/role?job=7";
  let posts = 0;
  const result = await startHostedRun("evaluate", target, async () => {
    posts++;
    return Response.json({ runId: "55555555-5555-4555-8555-555555555555", status: "queued" }, { status: 202 });
  }, { onTarget: (resolved, key) => persistJobsSnapshot(storage, "jobs", [{ id: "job-a", backend: "hosted", kind: "evaluate", status: "running", input: resolved, idempotencyKey: key, text: "private output" }]) });
  assert.equal(result.outcome, "started");
  assert.equal(posts, 1);
  const persisted = JSON.parse(records.get("jobs"));
  assert.equal(persisted[0].input, target);
  assert.match(persisted[0].idempotencyKey, /^ui-evaluation:[a-f0-9]{64}$/);
  assert.equal(persisted[0].text, "");

  const failedStorage = { setItem: () => { throw new Error("quota"); } };
  const blocked = await startHostedRun("pdf", "77", async () => { posts++; return Response.json({}); }, {
    onTarget: (resolved) => persistJobsSnapshot(failedStorage, "jobs", [{ backend: "hosted", kind: "pdf", input: resolved, status: "running" }]),
  });
  assert.equal(blocked.outcome, "rejected");
  assert.match(blocked.message, /storage could not save.*request was not started/i);
  assert.equal(posts, 1, "storage failure prevents the POST");
});

test("storage failure releases a hosted reservation and old safety markers cannot be evicted", () => {
  const reservations = new Map();
  reserveHostedStart(reservations, "pdf:77", "job-a");
  assert.equal(persistHostedJobSnapshot({ setItem: () => { throw new Error("quota"); } }, "jobs", [], reservations, "pdf:77", "job-a"), false);
  assert.equal(reservations.has("pdf:77"), false);

  const marker = (id) => ({ id, backend: "hosted", kind: "pdf", status: "error", startOutcome: "unknown", input: id });
  const manyMarkers = Array.from({ length:  41 }, (_, index) => marker(`job-${index}`));
  const records = new Map();
  assert.equal(persistJobsSnapshot({ setItem: (key, value) => records.set(key, value) }, "jobs", manyMarkers), false);
  assert.equal(records.has("jobs"), false, "must not overwrite the durable snapshot with one that loses a safety marker");

  const mixed = [...manyMarkers.slice(0, 2), ...Array.from({ length: 45 }, (_, index) => ({ id: `done-${index}`, backend: "local", status: "done" }))];
  assert.equal(persistJobsSnapshot({ setItem: (key, value) => records.set(key, value) }, "jobs", mixed), true);
  assert.equal(JSON.parse(records.get("jobs")).filter((job) => job.startOutcome === "unknown").length, 2);
});

test("hosted jobs send only an exact Inbox URL or validated application number to fixed APIs", () => {
  const url = "https://jobs.example/role?job=7";
  assert.deepEqual(getHostedStartRequest("evaluate", url), { path: "/api/evaluation-runs", body: { url } });
  assert.deepEqual(getHostedStartRequest("evaluate", url, "ui-retry:123"), { path: "/api/evaluation-runs", body: { url, idempotencyKey: "ui-retry:123" } });
  assert.deepEqual(getHostedStartRequest("evaluate", "77"), { path: "/api/evaluation-runs", body: { applicationNumber: "77" } });
  assert.deepEqual(getHostedStartRequest("pdf", "77"), { path: "/api/cv-runs", body: { applicationNumber: "77" } });
  assert.deepEqual(getHostedStartRequest("pdf", url), { path: "/api/cv-runs", body: { url } });
  assert.throws(() => getHostedStartRequest("evaluate", ` ${url}`), { message: "INVALID_HOSTED_TARGET" });
  assert.throws(() => getHostedStartRequest("pdf", "0"), { message: "INVALID_HOSTED_TARGET" });
  assert.throws(() => getHostedStartRequest("research", url), { message: "HOSTED_JOB_UNSUPPORTED" });
});

test("evaluation idempotency key is stable for the exact target and changes with target identity", async () => {
  const url = "https://jobs.example/role?job=7";
  const first = await hostedEvaluationIdempotencyKey(url);
  assert.equal(first, await hostedEvaluationIdempotencyKey(url));
  assert.notEqual(first, await hostedEvaluationIdempotencyKey("https://jobs.example/role?job=8"));
  assert.match(first, /^ui-evaluation:[a-f0-9]{64}$/);
});

test("evaluation start persists its stable exact-target key before the one-shot POST", async () => {
  const target = "https://jobs.example/role?job=7";
  const expectedKey = await hostedEvaluationIdempotencyKey(target);
  let persistedKey = null;
  const result = await startHostedRun("evaluate", target, async (path, options) => {
    assert.equal(path, "/api/evaluation-runs");
    assert.equal(persistedKey, expectedKey, "the client must persist the retry key before dispatch");
    assert.deepEqual(JSON.parse(options.body), { url: target, idempotencyKey: expectedKey });
    return Response.json({ runId: "55555555-5555-4555-8555-555555555555", status: "queued" }, { status: 202 });
  }, { onTarget: (_resolvedTarget, key) => { persistedKey = key; } });
  assert.equal(result.outcome, "started");
});

test("hosted start uses one fixed POST and marks network failure as an unknown outcome", async () => {
  let calls = 0;
  const result = await startHostedRun("pdf", "77", async (path, options) => {
    calls++;
    assert.equal(path, "/api/cv-runs");
    assert.equal(options.method, "POST");
    assert.deepEqual(JSON.parse(options.body), { applicationNumber: "77" });
    throw new Error("connection reset after request may have reached the server");
  });
  assert.equal(calls, 1);
  assert.equal(result.outcome, "unknown");
  assert.equal(result.runId, null);
  assert.match(result.message, /could not confirm.*may still be running/i);
  assert.doesNotMatch(result.message, /connection reset/i);
});

test("CV 5xx and unreadable responses remain unknown, while known validation 4xx is rejected", async () => {
  let posts = 0;
  const unknown = await startHostedRun("pdf", "77", async () => { posts++; return Response.json({ message: "private" }, { status: 500 }); });
  assert.equal(unknown.outcome, "unknown");
  assert.match(unknown.message, /check your hosted CV artifacts/);
  assert.equal(posts, 1, "an ambiguous CV start is never automatically reposted");
  const rejected = await startHostedRun("pdf", "77", async () => Response.json({ code: "APPLICATION_NOT_FOUND" }, { status: 404 }));
  assert.equal(rejected.outcome, "rejected");
  assert.match(rejected.message, /application number was not found/i);
});

test("quick evaluate imports first and sends only the returned exact Inbox URL to the evaluator", async () => {
  const calls = [];
  const expectedKey = await hostedEvaluationIdempotencyKey("https://employer.example/jobs/77");
  const result = await startHostedRun("evaluate", "https://www.linkedin.com/jobs/view/77", async (path, options) => {
    calls.push({ path, body: options?.body ? JSON.parse(options.body) : null });
    if (path === "/api/job-import") return Response.json({ status: "imported", normalizedUrl: "https://employer.example/jobs/77", company: "Example", role: "Engineer" });
    return Response.json({ runId: "55555555-5555-4555-8555-555555555555", status: "queued" }, { status: 202 });
  }, { importFirst: true });
  assert.deepEqual(calls, [
    { path: "/api/job-import", body: { url: "https://www.linkedin.com/jobs/view/77", source: "Quick Evaluate" } },
    { path: "/api/evaluation-runs", body: { url: "https://employer.example/jobs/77", idempotencyKey: expectedKey } },
  ]);
  assert.equal(result.outcome, "started");
});

test("quick evaluate does not bypass an import failure or send its arbitrary URL to evaluation", async () => {
  let calls = 0;
  const result = await startHostedRun("evaluate", "https://www.linkedin.com/jobs/view/77", async () => {
    calls++;
    return Response.json({ status: "failed", error: { code: "LINKEDIN_PAGE_UNAVAILABLE", message: "raw private detail" } }, { status: 422 });
  }, { importFirst: true });
  assert.equal(calls, 1);
  assert.equal(result.outcome, "rejected");
  assert.match(result.message, /LinkedIn may require sign-in or block automated access/);
  assert.doesNotMatch(result.message, /raw private detail/);
});

test("quick evaluate does not silently rerun an already-evaluated Inbox posting", async () => {
  let calls = 0;
  const result = await startHostedRun("evaluate", "https://employer.example/jobs/77", async () => {
    calls++;
    return Response.json({ status: "already_exists", applicationNumber: "77", normalizedUrl: "https://employer.example/jobs/77" });
  }, { importFirst: true });
  assert.equal(calls, 1);
  assert.equal(result.outcome, "existing");
  assert.match(result.message, /already has application #77/);
});

test("hosted start returns only an allowlisted run projection", async () => {
  const result = await startHostedRun("evaluate", "https://jobs.example/role", async () => Response.json({
    runId: "55555555-5555-4555-8555-555555555555", status: "queued", company: "Example", role: "Engineer",
    applicationNumber: null, reportPath: null, score: null, privateCV: "must not escape",
  }, { status: 202 }));
  assert.equal(result.outcome, "started");
  assert.deepEqual(result.run, {
    runId: "55555555-5555-4555-8555-555555555555", status: "queued", company: "Example", role: "Engineer",
    applicationNumber: null, reportPath: null, score: null, artifactPath: null, associationStatus: null, associationPending: false, errorCode: null, diagnosticCode: null,
  });
  assert.ok(!JSON.stringify(result).includes("privateCV"));
});

test("only the allowlisted GitHub Actions diagnostic survives and gives actionable dispatch guidance", async () => {
  const trusted = await startHostedRun("evaluate", "77", async () => Response.json({
    runId: "55555555-5555-4555-8555-555555555555", status: "failed",
    errorCode: "EVALUATION_WORKER_DISPATCH_FAILED", diagnosticCode: "GITHUB_ACTIONS_DISABLED",
  }));
  assert.equal(trusted.outcome, "failed");
  assert.equal(trusted.run.diagnosticCode, "GITHUB_ACTIONS_DISABLED");
  assert.match(trusted.message, /check the repository's Actions page and enable workflows if appropriate/i);

  const untrusted = await startHostedRun("evaluate", "77", async () => Response.json({
    runId: "55555555-5555-4555-8555-555555555555", status: "failed",
    errorCode: "EVALUATION_WORKER_DISPATCH_FAILED", diagnosticCode: "secret-private-text",
  }));
  assert.equal(untrusted.run.diagnosticCode, null);
  assert.match(untrusted.message, /safely resume this exact target/i);
  assert.doesNotMatch(JSON.stringify(untrusted), /secret-private-text/);
});

test("hosted status polling keeps nonterminal state and never exposes backend text", async () => {
  const result = await pollHostedRun("evaluate", "55555555-5555-4555-8555-555555555555", async path => {
    assert.equal(path, "/api/evaluation-runs/55555555-5555-4555-8555-555555555555");
    return Response.json({ runId: "55555555-5555-4555-8555-555555555555", status: "committing", errorMessage: "private internals" });
  });
  assert.equal(result.outcome, "running");
  assert.equal(result.run.status, "committing");
  assert.ok(!JSON.stringify(result).includes("private internals"));
});

test("hosted evaluation completion is unverified without application number, score and report path", async () => {
  const result = await pollHostedRun("evaluate", "55555555-5555-4555-8555-555555555555", async () => Response.json({
    runId: "55555555-5555-4555-8555-555555555555", status: "completed", score: 4.2,
  }));
  assert.equal(result.outcome, "unverified");
  assert.match(result.message, /application number, score, and report path/);
});

test("hosted CV completion requires its PDF artifact and reports pending tracker association without hiding the PDF", async () => {
  const result = await pollHostedRun("pdf", "55555555-5555-4555-8555-555555555555", async () => Response.json({
    runId: "55555555-5555-4555-8555-555555555555", status: "completed", applicationNumber: null,
    artifactPath: "output/cv-example-role-2026-10-28-55555555.pdf", associationStatus: "pending", associationPending: true,
  }));
  assert.equal(result.outcome, "completed");
  assert.match(result.message, /tracker association is still pending/);

  const missing = await pollHostedRun("pdf", "55555555-5555-4555-8555-555555555555", async () => Response.json({
    runId: "55555555-5555-4555-8555-555555555555", status: "completed", associationStatus: "linked",
  }));
  assert.equal(missing.outcome, "unverified");
});

test("hosted CV download path is same-origin and derived only from the validated run ID", () => {
  assert.equal(cvArtifactDownloadPath("55555555-5555-4555-8555-555555555555"), "/api/cv-artifacts/55555555-5555-4555-8555-555555555555/download");
  assert.equal(cvArtifactDownloadPath("../../api/cv-pdf?artifact=secret"), null);
});
