import assert from "node:assert/strict";
import test from "node:test";
import * as hostedCvPrompt from "../../src/lib/ai/hosted-cv-prompt.mjs";

const { sanitizeHostedProjectLinks } = hostedCvPrompt;

const sourceCv = `# Candidate\nEmail: synthetic@example.test\nPortfolio: https://example.com/profile\n\n## Projects\n### Public project\nRepository: https://github.com/example/public-project\n\n## Education\nB.S. Computer Science`;

function htmlWithProjectLink(href, label = "github.com/example/public-project") {
  return `<!doctype html><html><head><style></style></head><body>
    <div class="contact-row"><a href="https://example.com/profile">Profile</a></div>
    <!-- PROJECTS -->
    <div class="section"><div class="project"><div class="project-title">Public project</div>
      <div class="project-link"><a href="${href}">${label}</a></div>
    </div></div>
    <!-- EDUCATION -->
  </body></html>`;
}

test("hosted CV keeps a visible HTTPS project link grounded in the source Projects section", () => {
  assert.equal(typeof sanitizeHostedProjectLinks, "function");
  const safe = sanitizeHostedProjectLinks(htmlWithProjectLink("https://github.com/example/public-project"), sourceCv);

  assert.match(safe, /<a href="https:\/\/github\.com\/example\/public-project">github\.com\/example\/public-project<\/a>/);
  assert.match(safe, /class="contact-row"><a href="https:\/\/example\.com\/profile">Profile<\/a>/);
});

test("hosted CV removes a project link absent from the source Projects section", () => {
  const safe = sanitizeHostedProjectLinks(htmlWithProjectLink("https://github.com/elsewhere/not-a-project"), sourceCv);

  assert.doesNotMatch(safe, /href="https:\/\/github\.com\/elsewhere\/not-a-project"/);
  assert.doesNotMatch(safe, /class="project-link"/);
  assert.match(safe, /class="project-title">Public project<\/div>/);
});

test("hosted CV does not treat a URL in another source section as a project URL", () => {
  const otherSection = sourceCv.replace("## Projects", "## Employment");
  const safe = sanitizeHostedProjectLinks(htmlWithProjectLink("https://github.com/example/public-project"), otherSection);

  assert.doesNotMatch(safe, /href="https:\/\/github\.com\/example\/public-project"/);
  assert.doesNotMatch(safe, /class="project-link"/);
});

test("hosted CV removes non-HTTPS project links even when they appear in the source CV", () => {
  const httpSource = sourceCv.replace("https://github.com/example/public-project", "http://github.com/example/public-project");
  const safe = sanitizeHostedProjectLinks(htmlWithProjectLink("http://github.com/example/public-project"), httpSource);

  assert.doesNotMatch(safe, /href="http:\/\/github\.com\/example\/public-project"/);
  assert.doesNotMatch(safe, /class="project-link"/);
});

test("hosted CV preserves contact links but strips other unapproved document links", () => {
  const html = htmlWithProjectLink("https://github.com/example/public-project")
    .replace(
      '<div class="project-title">Public project</div>',
      '<div class="project-title"><a href="https://github.com/elsewhere/fake">Public project</a></div>',
    )
    .replace(
      "<!-- EDUCATION -->",
      '<!-- EDUCATION --><div class="education-link"><a href="https://example.com/degree">Education</a></div>',
    );
  const safe = sanitizeHostedProjectLinks(html, sourceCv);

  assert.match(safe, /class="project-link"><a href="https:\/\/github\.com\/example\/public-project">/);
  assert.doesNotMatch(safe, /href="https:\/\/github\.com\/elsewhere\/fake"/);
  assert.doesNotMatch(safe, /href="https:\/\/example\.com\/degree"/);
  assert.match(safe, /class="contact-row"><a href="https:\/\/example\.com\/profile">Profile<\/a>/);
});

test("hosted CV preserves only source-backed contact link targets", () => {
  const html = htmlWithProjectLink("https://github.com/example/public-project")
    .replace("https://example.com/profile", "https://attacker.example/fake");
  const safe = sanitizeHostedProjectLinks(html, sourceCv);

  assert.doesNotMatch(safe, /href="https:\/\/attacker\.example\/fake"/);
  assert.match(safe, /Profile/);
  assert.doesNotMatch(safe, /href="data:text\/html,/);
});

test("hosted CV link filtering resists decoy section markers before the real Projects section", () => {
  const html = htmlWithProjectLink("data:text/html,%3Cscript%3Ealert(1)%3C/script%3E", "unverified link")
    .replace("<head>", "<head><!-- PROJECTS --><!-- EDUCATION -->");
  const safe = sanitizeHostedProjectLinks(html, sourceCv);

  assert.doesNotMatch(safe, /href="data:text\/html,/);
  assert.doesNotMatch(safe, /class="project-link"/);
  assert.match(safe, /class="contact-row"><a href="https:\/\/example\.com\/profile">Profile<\/a>/);
});
