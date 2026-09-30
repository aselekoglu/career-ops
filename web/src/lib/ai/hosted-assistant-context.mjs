import { load as parseYaml } from "js-yaml";

const CV_LIMIT = 5_000;
const MEMORY_LIMIT = 1_500;
const PIPELINE_LIMIT = 2_500;

function clean(value, max) {
  if (typeof value !== "string") return "";
  return value
    .split(/\r?\n/)
    .filter((line) => !/\b(email|e-mail|phone|telephone|mobile|cell|address|street|postal|zip|linkedin|website|contact)\s*:/i.test(line))
    .join("\n")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[contact removed]")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[contact removed]")
    .replace(/https?:\/\/\S+/gi, "[link removed]")
    .replace(/\b\d{1,6}\s+[^\n,]{2,45}\b(?:street|st\.?|road|rd\.?|avenue|ave\.?|drive|dr\.?|boulevard|blvd\.?|lane|ln\.?)\b[^\n]*/gi, "[address removed]")
    .slice(0, max);
}

function profileSummary(raw) {
  if (typeof raw !== "string" || !raw) return "";
  let profile;
  try { profile = parseYaml(raw); } catch { return ""; }
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return "";
  const target = profile.target_roles;
  const roles = Array.isArray(target?.primary) ? target.primary : [];
  const allowedRoles = roles.filter((role) => typeof role === "string").slice(0, 6).map((role) => clean(role, 80));
  const flexibility = clean(profile.compensation?.location_flexibility, 100);
  return JSON.stringify({ targetRoles: allowedRoles, locationFlexibility: flexibility });
}

function pipelineSummary(snapshot) {
  const applications = Array.isArray(snapshot?.applications) ? snapshot.applications : [];
  const inbox = Array.isArray(snapshot?.inbox) ? snapshot.inbox : [];
  const statuses = Object.create(null);
  for (const app of applications) {
    const status = clean(app.status, 30);
    if (status) statuses[status] = (statuses[status] ?? 0) + 1;
  }
  const recent = applications.slice(-12).map((app) => ({
    company: clean(app.company, 80), role: clean(app.role, 100),
    status: clean(app.status, 30), score: clean(app.score, 20),
  }));
  return JSON.stringify({ totalApplications: applications.length, pendingInbox: inbox.filter((job) => !job.done).length, statuses, recent }).slice(0, PIPELINE_LIMIT);
}

/** Fetch only data relevant to this turn, and reduce it before giving it to Gemini. */
export async function buildHostedAssistantContext({ message = "", pagePath = "/", readCv, readMemory, readProfile, readPipeline }) {
  const question = typeof message === "string" ? message : "";
  const page = typeof pagePath === "string" && /^\/[a-zA-Z0-9/_-]{0,180}$/.test(pagePath) ? pagePath : "/";
  const needsCv = /\b(cv|resume|résumé|experience|skills|background|fit|match|qualifications?|cover letter)\b/i.test(question) || page === "/cv";
  const needsMemory = /\b(preferen\w*|remember|memory|about me|my goals|my priorities|fit|match)\b/i.test(question);
  const needsPipeline = /\b(pipeline|applications?|inbox|offers?|interviews?|job search|what should i do)\b/i.test(question) || page === "/pipeline" || page.startsWith("/pipeline/");
  const needsProfile = needsCv || needsPipeline || /\b(roles?|career|target|location|remote|salary|compensation|about me|profile|jobs?)\b/i.test(question);
  const [rawCv, rawMemory, rawProfile, rawPipeline] = await Promise.all([
    needsCv ? readCv() : "",
    needsMemory ? readMemory() : "",
    needsProfile ? readProfile() : "",
    needsPipeline ? readPipeline() : null,
  ]);
  return {
    cv: clean(rawCv, CV_LIMIT),
    memory: clean(rawMemory, MEMORY_LIMIT),
    profile: profileSummary(rawProfile),
    pipeline: needsPipeline ? pipelineSummary(rawPipeline) : "",
    page,
  };
}
