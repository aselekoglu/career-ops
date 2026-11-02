import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantRequestMode, parseAssistantAiStatus, createAssistantTurnGuard } from "../../src/lib/ai/hosted-assistant-client.mjs";

test("status failures and malformed status stay unknown even with a saved CLI", () => {
  for (const payload of [null, undefined, {}, { hosted: false }, { hosted: "false", ready: false, geminiConfigured: false }, { hosted: false, ready: "false", geminiConfigured: false }]) {
    const status = parseAssistantAiStatus(payload);
    assert.equal(status, null);
    assert.equal(assistantRequestMode(status, "claude"), "disabled");
  }
  assert.equal(assistantRequestMode(null, "claude"), "disabled"); // non-OK/network failure
  assert.equal(assistantRequestMode(parseAssistantAiStatus({ hosted: false, ready: false, geminiConfigured: false }), "claude"), "local");
  assert.equal(assistantRequestMode(parseAssistantAiStatus({ hosted: true, ready: true, geminiConfigured: true }), null), "hosted");
});

test("reset during an active stream leaves the new greeting and blocks stale actions and cleanup", () => {
  const guard = createAssistantTurnGuard();
  const turn = guard.begin();
  let messages = ["old answer"];
  let busy = true;
  const actions = [];
  guard.invalidate(); // reset before an old reader resolves
  messages = ["fresh greeting"];
  busy = false;
  guard.run(turn, () => { messages = ["late streamed text"]; });
  guard.run(turn, () => { actions.push("navigate"); });
  guard.run(turn, () => { messages = ["old connection error"]; });
  guard.run(turn, () => { busy = false; });
  assert.deepEqual(messages, ["fresh greeting"]);
  assert.deepEqual(actions, []);
  assert.equal(busy, false);
  const nextTurn = guard.begin();
  guard.run(nextTurn, () => { messages = ["new answer"]; });
  assert.deepEqual(messages, ["new answer"]);
});
