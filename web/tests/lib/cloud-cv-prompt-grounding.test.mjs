import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// cloud-cv-runs.mjs imports Next.js/Vercel's extensionless modules, so it cannot
// be imported directly in a native Node test. Verify the static prompt contract
// without inventing a second renderer or skipping its runtime build checks.
const source = readFileSync(
  fileURLToPath(new URL("../../src/lib/cloud-cv-runs.mjs", import.meta.url)),
  "utf8",
);

test("hosted tailoring prompt requires every candidate claim to come from source CV", () => {
  assert.match(source, /SOURCE CV is the authoritative evidence for candidate facts/);
  assert.match(source, /Every skill, technology, work practice, achievement/);
  assert.match(source, /Do not infer TDD or Extreme Programming/);
  assert.match(source, /Only include a contact field, especially a telephone number/);
  assert.match(source, /Never use sample\/template\/default phone numbers/);
  assert.match(source, /preserve the exact numeric amount and unit/);
  assert.match(source, /Job requirements suggest emphasis, never new qualifications/);
  assert.match(source, /Delete optional elements and their separators/);
});
