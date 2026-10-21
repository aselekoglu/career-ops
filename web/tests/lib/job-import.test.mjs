import test from "node:test";
import assert from "node:assert/strict";
import {
  extractJobPosting,
  fetchPublicPosting,
  importPosting,
  isPublicAddress,
  normalizeJobUrl,
  resolveAtsPosting,
  validateJobUrl,
} from "../../src/lib/job-import.mjs";

test("Lever apply URLs normalize to one posting URL while retaining the original elsewhere", () => {
  const url = "https://jobs.lever.co/magnetforensics/454d7903-cb1b-40ff-b7a8-5bc2e87e7329/apply?source=LinkedIn&utm_campaign=october";
  assert.equal(normalizeJobUrl(url), "https://jobs.lever.co/magnetforensics/454d7903-cb1b-40ff-b7a8-5bc2e87e7329");
  assert.equal(normalizeJobUrl(url.replace("LinkedIn", "Indeed")), normalizeJobUrl(url));
  assert.equal(normalizeJobUrl("http://boards.greenhouse.io/acme/jobs/12345/"), "https://boards.greenhouse.io/acme/jobs/12345");
});

test("normalization keeps non-tracking query parameters that may identify a job", () => {
  assert.equal(
    normalizeJobUrl("https://jobs.example.org/opening?jobId=42&utm_source=feed&locale=fr"),
    "https://jobs.example.org/opening?jobId=42&locale=fr",
  );
});

test("generic origin, path spelling, trailing slash, and repeated query order preserve identity", () => {
  assert.notEqual(normalizeJobUrl("https://www.example.org/jobs//123/?a=1&a=2"), normalizeJobUrl("https://example.org/jobs/123?a=2&a=1"));
  assert.throws(() => validateJobUrl("file:///etc/passwd"), { message: "UNSUPPORTED_SCHEME" });
  assert.throws(() => validateJobUrl("https://user:pass@example.org/job"), { message: "INVALID_URL" });
  assert.throws(() => validateJobUrl("http://2130706433/"), { message: "PRIVATE_NETWORK_BLOCKED" });
});

test("public address validation rejects private, reserved, mapped, and alternate IPv4 forms", () => {
  for (const ip of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "100.64.0.1", "192.0.2.5", "224.0.0.1", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "2001:db8::1", "2001:0:1::", "2002:7f00:1::", "3fff::1"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("generic extraction reads JobPosting JSON-LD fields without inventing unknowns", () => {
  const html = `<html><script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Senior Engineer","description":"<p>Build reliable systems.</p>","datePosted":"2026-09-01","employmentType":"FULL_TIME","hiringOrganization":{"@type":"Organization","name":"Example Corp"},"jobLocation":{"address":{"addressLocality":"Toronto","addressRegion":"ON"}},"baseSalary":{"currency":"CAD","value":{"minValue":120000,"maxValue":150000}}}</script></html>`;
  assert.deepEqual(extractJobPosting(html, "https://jobs.example.org/role/1"), {
    company: "Example Corp", role: "Senior Engineer", location: "Toronto, ON", workArrangement: null,
    postingDate: "2026-09-01", employmentType: "FULL_TIME", compensation: "CAD 120000-150000",
    jobDescription: "Build reliable systems.", ats: null, externalPostingId: null, expired: false, ambiguousPosting: false,
  });
  const sparse = extractJobPosting("<h1>Join us</h1><p>General company content, not a job title.</p>", "https://example.org/jobs/1");
  assert.equal(sparse.company, null);
  assert.equal(sparse.role, null);
});

test("generic company career landing title is not promoted to a job role", () => {
  const landing = `<meta property="og:site_name" content="Acme"><meta property="og:title" content="Careers at Acme"><h1>Careers</h1><p>${"Explore our teams and culture. ".repeat(10)}</p>`;
  const fields = extractJobPosting(landing, "https://careers.acme.example/careers");
  assert.equal(fields.company, "Acme");
  assert.equal(fields.role, null);
  assert.equal(fields.jobDescription, null);
});

test("generic JSON-LD lists require one exact posting match and expired postings are rejected", () => {
  const description = "Build reliable systems and collaborate with engineering teams. ".repeat(3);
  const postings = ["one", "two"].map(id => ({ "@type": "JobPosting", "@id": `https://example.org/jobs/${id}`, url: `https://example.org/jobs/${id}`, title: `Engineer ${id}`, description, hiringOrganization: { name: "Example Corp" } }));
  const html = `<script type="application/ld+json">${JSON.stringify({ "@graph": postings })}</script>`;
  assert.equal(extractJobPosting(html, "https://example.org/jobs/unrelated").ambiguousPosting, true);
  assert.equal(extractJobPosting(html, "https://example.org/jobs/two").role, "Engineer two");
  const expired = `<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: "Engineer", description, validThrough: "2020-01-01", hiringOrganization: { name: "Example Corp" } })}</script>`;
  assert.equal(extractJobPosting(expired, "https://example.org/job").expired, true);
});

test("careers and job-not-found pages cannot pass from generic titles and marketing copy", () => {
  for (const title of ["Careers | Acme", "Job Not Found | Acme"]) {
    const html = `<meta property="og:site_name" content="Acme"><meta property="og:title" content="${title}"><h1>${title}</h1><main><p>${"Explore our company culture and teams. ".repeat(12)}</p></main>`;
    const fields = extractJobPosting(html, "https://acme.example/careers");
    assert.equal(fields.role, null, title);
    assert.equal(fields.jobDescription, null, title);
  }
});

test("generic employer pages need marked job-description evidence", () => {
  const noMarkup = `<meta property="og:site_name" content="Acme"><meta property="og:title" content="Engineer | Acme Careers"><h2>Engineer</h2><main><p>${"Company news and culture. ".repeat(10)}</p></main>`;
  assert.equal(extractJobPosting(noMarkup, "https://acme.example/careers/role").jobDescription, null);
  const withMarkup = `<meta property="og:site_name" content="Acme Careers | Acme"><meta property="og:title" content="Engineer | Acme Careers"><h1>Careers</h1><h2>Engineer</h2><div class="job-description"><p>${"Responsibilities include building services. ".repeat(5)}</p></div>`;
  const fields = extractJobPosting(withMarkup, "https://acme.example/careers/role");
  assert.equal(fields.company, "Acme");
  assert.equal(fields.role, "Engineer");
  assert.match(fields.jobDescription, /Responsibilities/);
});

test("known public Greenhouse, Ashby, and Workday posting URLs map to fixed structured APIs", () => {
  assert.deepEqual(resolveAtsPosting("https://boards.greenhouse.io/acme/jobs/12345"), {
    ats: "greenhouse", apiUrl: "https://boards-api.greenhouse.io/v1/boards/acme/jobs/12345", id: "12345",
  });
  assert.deepEqual(resolveAtsPosting("https://jobs.ashbyhq.com/acme/1234-5678"), {
    ats: "ashby", apiUrl: "https://api.ashbyhq.com/posting-api/job-board/acme", org: "acme", id: "1234-5678",
  });
  assert.deepEqual(resolveAtsPosting("https://acme.wd5.myworkdayjobs.com/en-US/External/job/Toronto-ON/Engineer_R123"), {
    ats: "workday", apiUrl: "https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/job/Toronto-ON/Engineer_R123", tenant: "acme", site: "External", id: "Engineer_R123",
  });
  assert.equal(resolveAtsPosting("https://acme.wd5.myworkdayjobs.com/../../etc/passwd"), null);
});

test("redirected generic posting returns the validated final canonical URL", async () => {
  const html = `<script type="application/ld+json">{"@type":"JobPosting","title":"Platform Engineer","description":"${"Build dependable platform services. ".repeat(5)}","hiringOrganization":{"name":"Example Corp"}}</script>`;
  const result = await importPosting("https://jobs.example.org/redirect", {
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async ({ url }) => url.hostname === "jobs.example.org"
      ? { status: 302, headers: { location: "https://careers.example.org/openings/engineer" }, body: "" }
      : { status: 200, headers: { "content-type": "text/html" }, body: html },
  });
  assert.equal(result.ok, true);
  assert.equal(result.normalizedUrl, "https://careers.example.org/openings/engineer");
  assert.equal(result.requestedNormalizedUrl, "https://jobs.example.org/redirect");
  assert.equal(result.posting.company, "Example Corp");
  assert.equal(result.posting.role, "Platform Engineer");
});

test("every redirect is revalidated before a second socket request", async () => {
  const calls = [];
  const result = await fetchPublicPosting("https://jobs.example.org/first", {
    resolve: async (host) => [{ address: host === "jobs.example.org" ? "93.184.216.34" : "127.0.0.1", family: 4 }],
    request: async ({ url, lookup }) => {
      calls.push(url.href);
      const pinned = await new Promise((resolve, reject) => lookup(url.hostname, {}, (error, address, family) => error ? reject(error) : resolve({ address, family })));
      assert.equal(pinned.address, "93.184.216.34");
      return { status: 302, headers: { location: "http://127.0.0.1/admin" }, body: "" };
    },
  });
  assert.equal(result.error, "PRIVATE_NETWORK_BLOCKED");
  assert.equal(calls.length, 1);
});

test("all DNS results must be public and the lookup callback is pinned", async () => {
  let requestCalls = 0;
  const result = await fetchPublicPosting("https://jobs.example.org/role", {
    resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.4", family: 4 }],
    request: async () => { requestCalls++; return { status: 200, headers: {}, body: "x" }; },
  });
  assert.equal(result.error, "PRIVATE_NETWORK_BLOCKED");
  assert.equal(requestCalls, 0);
});

test("response byte cap and timeout return structured failures", async () => {
  const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
  assert.equal((await fetchPublicPosting("https://jobs.example.org/role", {
    resolve, maxBytes: 3, request: async () => ({ status: 200, headers: {}, body: "large" }),
  })).error, "FETCH_TOO_LARGE");
  assert.equal((await fetchPublicPosting("https://jobs.example.org/role", {
    timeoutMs: 5, resolve, request: async () => new Promise(() => {}),
  })).error, "FETCH_TIMEOUT");
});

test("the total deadline includes DNS resolution", async () => {
  let requestCalls = 0;
  const result = await fetchPublicPosting("https://jobs.example.org/role", {
    timeoutMs: 10,
    resolve: async () => { await new Promise(resolve => setTimeout(resolve, 20)); return [{ address: "93.184.216.34", family: 4 }]; },
    request: async () => { requestCalls++; return { status: 200, headers: {}, body: "ok" }; },
  });
  assert.equal(result.error, "FETCH_TIMEOUT");
  assert.equal(requestCalls, 0);
});
