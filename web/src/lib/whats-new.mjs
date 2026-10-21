/** Read recent, not-yet-evaluated scan-history rows for the Explorer feed. */
export function collectWhatsNew(rows, { cutoff, toOffer, limit = 24, legacyLimit = 12 }) {
  const seen = new Set();
  const offers = [];
  let anyDated = false;
  for (let i = rows.length - 1; i >= 1 && offers.length < limit; i--) {
    const cells = rows[i].split("\t");
    const time = Date.parse(cells[1] || "");
    if (Number.isFinite(time)) anyDated = true;
    if (!Number.isFinite(time) || time < cutoff) continue;
    const url = cells[0];
    if (!url || seen.has(url)) continue;
    // A later skipped/expired row retires the URL. Mark it before the row
    // predicate so an older `added` row cannot resurface it.
    seen.add(url);
    const offer = toOffer(cells);
    if (!offer) continue;
    offers.push(offer);
  }
  // Legacy scan histories may lack parseable first_seen dates. In that case
  // use append order as the only available freshness signal.
  if (offers.length === 0 && !anyDated) {
    for (let i = rows.length - 1; i >= 1 && offers.length < legacyLimit; i--) {
      const cells = rows[i].split("\t");
      const url = cells[0];
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const offer = toOffer(cells);
      if (!offer) continue;
      offers.push(offer);
    }
  }
  return { offers, count: offers.length };
}
