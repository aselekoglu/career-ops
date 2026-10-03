import assert from "node:assert/strict";
import test from "node:test";
import { importedPostingPath } from "../../src/lib/job-import.mjs";
import { loadJobDescription, readStoredJobDescription } from "../../src/lib/cloud-job-import.mjs";

const url = "https://jobs.example.org/roles/42";
const description = "An imported job description with responsibilities and qualifications. ".repeat(4).trim();
const documentFor = normalizedUrl => ({
  content_encoding: "utf8",
  content: JSON.stringify({ normalizedUrl, jobDescription: description, company: "Example Co", role: "Engineer", source: "board" }),
});

test("stored JD is consumed only when its embedded normalized URL exactly matches", async () => {
  let requestedPath;
  const result = await readStoredJobDescription(url, async path => {
    requestedPath = path;
    return documentFor(url);
  });
  assert.equal(requestedPath, importedPostingPath(url));
  assert.equal(result, description);
});

test("a mismatched stored URL falls back to the existing posting fetch", async () => {
  const calls = [];
  const result = await loadJobDescription(url, {
    readDocument: async () => documentFor("https://jobs.example.org/roles/41"),
    fetchFallback: async requestedUrl => { calls.push(requestedUrl); return "fetched from the existing path"; },
  });
  assert.equal(result, "fetched from the existing path");
  assert.deepEqual(calls, [url]);
});

test("missing, malformed, and non-UTF8 sidecars fall back safely", async () => {
  const rows = [
    null,
    { content_encoding: "utf8", content: "{" },
    { content_encoding: "base64", content: documentFor(url).content },
  ];
  for (const row of rows) {
    const result = await loadJobDescription(url, {
      readDocument: async () => row,
      fetchFallback: async () => "existing fetch path",
    });
    assert.equal(result, "existing fetch path");
  }
});

test("a producer-shaped long imported JD is bounded without refetching", async () => {
  const longDescription = "x".repeat(24_500);
  let fetched = false;
  const result = await loadJobDescription(url, {
    readDocument: async () => ({ content_encoding: "utf8", content: JSON.stringify({ normalizedUrl: url, company: "Example Co", role: "Engineer", jobDescription: longDescription }) }),
    fetchFallback: async () => { fetched = true; return "unexpected network fetch"; },
    maxChars: 24_000,
  });
  assert.equal(result, "x".repeat(24_000));
  assert.equal(fetched, false);
});

test("a valid imported description avoids the network fallback", async () => {
  let fetched = false;
  const result = await loadJobDescription(url, {
    readDocument: async () => documentFor(url),
    fetchFallback: async () => { fetched = true; return "unexpected"; },
  });
  assert.equal(result, description);
  assert.equal(fetched, false);
});
