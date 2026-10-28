const BATCH_KEY = "career-ops:hosted-shortlist-batch";

export function createShortlistBatch(items, batchId) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 40 || typeof batchId !== "string") return null;
  const safeItems = items.filter((item) => item && typeof item.url === "string" && item.url.length <= 2048 &&
    typeof item.company === "string" && typeof item.role === "string");
  if (safeItems.length !== items.length) return null;
  return { batchId, items: safeItems, nextIndex: 0, activeJobId: null };
}

export function parseShortlistBatch(value) {
  try {
    const batch = typeof value === "string" ? JSON.parse(value) : value;
    if (!batch || typeof batch !== "object" || typeof batch.batchId !== "string" || !Array.isArray(batch.items) ||
        !Number.isInteger(batch.nextIndex) || batch.nextIndex < 0 || batch.nextIndex > batch.items.length ||
        !(batch.activeJobId === null || typeof batch.activeJobId === "string")) return null;
    return createShortlistBatch(batch.items, batch.batchId) ? batch : null;
  } catch { return null; }
}

export function advanceShortlistBatch(batch) {
  if (!batch || batch.nextIndex >= batch.items.length) return null;
  const nextIndex = batch.nextIndex + 1;
  return nextIndex >= batch.items.length ? null : { ...batch, nextIndex, activeJobId: null };
}

export function resolveShortlistBatchActiveJob(batch, jobs, jobsReady) {
  if (!batch?.activeJobId) return { state: "unassigned", job: null };
  if (!jobsReady) return { state: "loading", job: null };
  const job = jobs.find((candidate) => candidate.id === batch.activeJobId);
  return job ? { state: "found", job } : { state: "missing", job: null };
}

export function persistShortlistBatch(storage, batch) {
  try {
    if (batch == null) storage.removeItem(BATCH_KEY);
    else storage.setItem(BATCH_KEY, JSON.stringify(batch));
    return true;
  } catch { return false; }
}

export function readShortlistBatch(storage) {
  try { return parseShortlistBatch(storage.getItem(BATCH_KEY)); }
  catch { return null; }
}

export const SHORTLIST_BATCH_STORAGE_KEY = BATCH_KEY;
