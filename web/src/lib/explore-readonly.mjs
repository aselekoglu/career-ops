/** Unknown execution context fails closed; local CLI results retain their actions. */
export function isHostedExploreReadOnly(executionMode, mode, offerSource) {
  return executionMode !== "local" && (mode === "ai" || offerSource === "ai-search");
}
