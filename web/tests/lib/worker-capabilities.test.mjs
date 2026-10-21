import test from "node:test";
import assert from "node:assert/strict";
import { CAPS, KNOWN_KINDS, capabilitiesFor } from "../../src/lib/worker-capabilities.mjs";
import { toolScopeFor } from "../../src/lib/claude-invocation.mjs";

test("every /api/run kind has one capability record and a matching Claude scope", () => {
  assert.deepEqual(KNOWN_KINDS, ["pdf", "research", "evaluate", "fix-portal"]);
  for (const kind of KNOWN_KINDS) {
    const capability = capabilitiesFor(kind);
    assert.equal(typeof capability.writes, "boolean", `${kind} declares write access`);
    assert.ok([false, "search", "fetch"].includes(capability.network), `${kind} declares network access`);
    const scope = toolScopeFor(kind);
    const allowed = new Set(scope.allowed.split(","));
    assert.equal(allowed.has("Write"), capability.writes, `${kind} write capability matches its CLI scope`);
    assert.equal(allowed.has("WebFetch"), Boolean(capability.network), `${kind} network capability matches its CLI scope`);
  }
});

test("unreviewed kinds fail closed and the evaluated posting cannot write files", () => {
  assert.equal(capabilitiesFor("future-kind"), CAPS.localReadOnly);
  assert.equal(capabilitiesFor("pdf"), CAPS.localReadOnly);
  assert.equal(capabilitiesFor("evaluate"), CAPS.networkReadOnly);
  assert.equal(capabilitiesFor("fix-portal"), CAPS.workspaceWrite);
});
