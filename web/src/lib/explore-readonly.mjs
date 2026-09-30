/** Hosted AI discoveries are always view-only; local CLI behavior stays intact. */
export function isHostedExploreReadOnly(hostedMode, mode, offerSource) {
  return hostedMode === true && (mode === "ai" || offerSource === "ai-search");
}
