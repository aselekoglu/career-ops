import test from "node:test";
import assert from "node:assert/strict";
import { buildPrompt } from "../../src/lib/cloud-cv-runs.mjs";

test("hosted CV prompt uses source CV only for claims and contact details", () => {
  const { system, user } = buildPrompt({
    company: "Mechanical Orchard",
    role: "Software Engineer",
    url: "https://jobs.example.test/job",
    cv: "Full-stack developer. Email: example@example.test. Java and automated tests.",
    profile: "Template contact field: (613) 000-1234",
    targetEvidence: "The job requests Extreme Programming (XP) and test-driven development.",
    requestedFormat: "letter",
  });
  assert.match(system, /SOURCE CV is the authoritative evidence/);
  assert.match(system, /Every skill, technology, work practice/);
  assert.match(system, /Only include a contact field, especially a telephone number/);
  assert.match(system, /Never use sample\/template\/default phone numbers/);
  assert.match(system, /preserve the exact numeric amount and unit/);
  assert.match(user, /Job requirements suggest emphasis, never new qualifications/);
  assert.match(user, /Delete optional elements and their separators/);
  assert.match(user, /Full-stack developer/);
});
