import test from "node:test";
import assert from "node:assert/strict";
import { createPortfolioOperationKeys, portfolioErrorMessage } from "../../src/lib/portfolio-client.mjs";

test("a failed mutation retry keeps its UUID, while changed input starts a new operation", () => {
  let next = 0;
  const keys = createPortfolioOperationKeys(() => `operation-${++next}`);
  const payload = { operation: "update-metadata", id: "portfolio-1", changes: { title: "A" } };
  const first = keys.begin("metadata:portfolio-1", payload);
  assert.equal(keys.begin("metadata:portfolio-1", { ...payload, changes: { title: "A" } }), first);
  const changed = keys.begin("metadata:portfolio-1", { ...payload, changes: { title: "B" } });
  assert.notEqual(changed, first);
  assert.equal(keys.begin("metadata:portfolio-1", { ...payload, changes: { title: "B" } }), changed);
  keys.complete("metadata:portfolio-1", first);
  keys.complete("metadata:portfolio-1", changed);
  assert.equal(keys.begin("metadata:portfolio-1", { ...payload, changes: { title: "C" } }), "operation-3");
});

test("revision/source conflicts explain the recovery step", () => {
  assert.match(portfolioErrorMessage("PORTFOLIO_REVISION_CONFLICT", 409), /Refresh it/);
  assert.match(portfolioErrorMessage("PORTFOLIO_SOURCE_REVIEW_REQUIRED", 422), /Source review/);
  assert.match(portfolioErrorMessage("PORTFOLIO_ACTIVE_RUN_EXISTS", 409), /Review or cancel that run/);
});
