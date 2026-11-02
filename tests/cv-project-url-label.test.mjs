import assert from "node:assert/strict";
import test from "node:test";
import { validatePayload } from "../lib/cv-payload-schema.mjs";

test("HTML project payload accepts url_label without a dropped-field warning", () => {
  const result = validatePayload({
    projects: [{
      name: "Public project",
      url: "https://github.com/example/public-project",
      url_label: "github.com/example/public-project",
    }],
  }, "html");

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});
