import assert from "node:assert/strict";
import test from "node:test";
import { handleJobImportRequest } from "../../src/lib/cloud-job-import.mjs";

const body = { url: "https://jobs.example.org/role" };
const request = value => new Request("https://career-ops.example/api/job-import", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
});

test("invalid URL returns a safe structured error before storage access", async () => {
  let storeCalls = 0;
  const response = await handleJobImportRequest(request({ url: "not-a-url" }), {
    getStore: () => { storeCalls++; throw new Error("must not access storage"); },
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { status: "failed", originalUrl: "not-a-url", error: { code: "INVALID_URL", message: "Enter a valid public job posting URL." } });
  assert.equal(storeCalls, 0);
});

test("duplicate Inbox record returns before network fetch, including an expired source URL", async () => {
  const existing = { status: "already_exists", existing: true, inboxId: "inb_stable", originalUrl: body.url, normalizedUrl: body.url, company: "Acme", role: "Engineer", applicationNumber: null, createdAt: null };
  let fetches = 0;
  const response = await handleJobImportRequest(request(body), {
    getStore: () => ({ findImport: async () => existing }),
    importFn: async () => { fetches++; throw new Error("must not refetch"); },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "already_exists");
  assert.equal(fetches, 0);
});

test("fetch or extraction failure never reaches the durable Inbox writer", async () => {
  let writes = 0;
  const response = await handleJobImportRequest(request(body), {
    getStore: () => ({ findImport: async () => null, importPosting: async () => { writes++; } }),
    importFn: async () => ({ ok: false, originalUrl: body.url, normalizedUrl: body.url, error: "POSTING_NOT_FOUND" }),
  });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "POSTING_NOT_FOUND");
  assert.equal(writes, 0);
});

test("success persists the final canonical URL and returns the stable Inbox contract", async () => {
  const normalizedUrl = "https://careers.example.org/jobs/42";
  let saved;
  const response = await handleJobImportRequest(request({ ...body, source: "Job board", forceRefresh: true }), {
    getStore: () => ({ findImport: async () => null, importPosting: async input => { saved = input; return { status: "imported", existing: false, inboxId: "inb_123", originalUrl: input.originalUrl, normalizedUrl: input.normalizedUrl, company: "Acme", role: "Engineer", applicationNumber: null, createdAt: "2026-10-03T00:00:00.000Z" }; } }),
    importFn: async () => ({ ok: true, originalUrl: body.url, requestedNormalizedUrl: body.url, normalizedUrl, posting: { company: "Acme", role: "Engineer", jobDescription: "A complete posting. ".repeat(8) } }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, "imported");
  assert.equal(payload.normalizedUrl, normalizedUrl);
  assert.equal(saved.requestedNormalizedUrl, body.url);
  assert.equal(saved.source, "Job board");
  assert.equal(saved.forceRefresh, true);
});

test("closed request fields, source length, and forceRefresh type are enforced", async () => {
  for (const value of [
    { ...body, extra: true },
    { ...body, source: "s".repeat(501) },
    { ...body, forceRefresh: "true" },
  ]) {
    const response = await handleJobImportRequest(request(value), { getStore: () => { throw new Error("must not access storage"); } });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "INVALID_REQUEST");
  }
});

test("unsupported MIME types and oversized bodies are rejected before parsing", async () => {
  const wrongMime = await handleJobImportRequest(new Request("https://career-ops.example/api/job-import", {
    method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(body),
  }));
  assert.equal(wrongMime.status, 415);

  const tooLarge = await handleJobImportRequest(new Request("https://career-ops.example/api/job-import", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://jobs.example.org/role", source: "s".repeat(5000) }),
  }));
  assert.equal(tooLarge.status, 413);
});

test("private URLs fail before storage access or importer fetch", async () => {
  let calls = 0;
  const response = await handleJobImportRequest(request({ url: "http://127.0.0.1/admin" }), {
    getStore: () => { calls++; throw new Error("must not access storage"); },
    importFn: async () => { calls++; throw new Error("must not fetch"); },
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "PRIVATE_NETWORK_BLOCKED");
  assert.equal(calls, 0);
});

test("storage errors return a fixed safe error without leaking diagnostics", async () => {
  const response = await handleJobImportRequest(request(body), {
    getStore: () => ({ findImport: async () => { throw new Error("postgres://secret-host/private diagnostic"); } }),
  });
  assert.equal(response.status, 503);
  const payload = await response.text();
  assert.match(payload, /DATABASE_WRITE_FAILED/);
  assert.doesNotMatch(payload, /secret-host|private diagnostic/);
});

test("missing DATABASE_URL fails closed before creating the cloud store", async () => {
  const response = await handleJobImportRequest(request(body), {
    getStore: () => { throw new Error("JOB_IMPORT_STORAGE_UNAVAILABLE"); },
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "UPSTREAM_UNAVAILABLE");
});
