import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Verify the pure hosted CV prompt contract without importing Next.js/Vercel
// runtime dependencies or inventing a second renderer.
const source = readFileSync(
  fileURLToPath(new URL("../../src/lib/ai/hosted-cv-prompt.mjs", import.meta.url)),
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
