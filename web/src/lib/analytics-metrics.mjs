const APPLIED_OR_LATER = new Set([
  "APPLIED", "RESPONDED", "ASSESSMENT", "INTERVIEW", "OFFER", "HIRED", "REJECTED",
]);
const RESPONDED_OR_LATER = new Set([
  "RESPONDED", "ASSESSMENT", "INTERVIEW", "OFFER", "HIRED", "REJECTED",
]);
const INTERVIEW_OR_LATER = new Set(["INTERVIEW", "OFFER", "HIRED"]);
const OFFER_OR_LATER = new Set(["OFFER", "HIRED"]);
const ACTIVE_STATUSES = new Set(["APPLIED", "RESPONDED", "ASSESSMENT", "INTERVIEW", "OFFER"]);

/**
 * Compute the current-snapshot cumulative funnel, in the same order and with
 * the same status rules as stats.mjs. Assessment proves an application and a
 * response, but not an interview. Hired proves every stage through Offer;
 * Rejected proves application and response.
 *
 * @param {Array<{status?: string | null}>} applications
 * @param {(status: string) => string} [canonStatus]
 * @returns {{funnel: Array<{key: string, label: string, count: number}>, activeApps: number, totalOffers: number}}
 */
export function computeProgressMetrics(applications, canonStatus = value => String(value ?? "").trim().toUpperCase()) {
  const statuses = (Array.isArray(applications) ? applications : [])
    .map((application) => canonStatus(String(application?.status ?? "")));
  const countWhere = (included) => statuses.filter((status) => included.has(status)).length;
  const total = statuses.length;
  const funnel = [
    { key: "EVALUATED", label: "Evaluated", count: total },
    { key: "APPLIED", label: "Applied", count: countWhere(APPLIED_OR_LATER) },
    { key: "RESPONDED", label: "Responded", count: countWhere(RESPONDED_OR_LATER) },
    { key: "INTERVIEW", label: "Interview", count: countWhere(INTERVIEW_OR_LATER) },
    { key: "OFFER", label: "Offer", count: countWhere(OFFER_OR_LATER) },
  ];
  return {
    funnel,
    activeApps: countWhere(ACTIVE_STATUSES),
    totalOffers: countWhere(OFFER_OR_LATER),
  };
}
