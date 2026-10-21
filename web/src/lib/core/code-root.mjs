import fs from "node:fs";
import path from "node:path";

/**
 * Resolve the repository checkout that contains the web/ application.
 *
 * CAREER_OPS_ROOT points at user data and may be a different checkout, so it
 * must not be used to locate worker scripts. Set CAREER_OPS_CODE_ROOT when the
 * running web app is outside the checkout that contains web/.
 */
export function resolveCodeRoot(cwd = process.cwd(), env = process.env) {
  const configured = typeof env?.CAREER_OPS_CODE_ROOT === "string"
    ? env.CAREER_OPS_CODE_ROOT.trim()
    : "";
  if (configured) return path.resolve(cwd, configured);

  const start = path.resolve(cwd);
  let directory = start;
  while (true) {
    if (
      path.basename(directory).toLowerCase() === "web" &&
      fs.existsSync(path.join(directory, "package.json"))
    ) {
      return path.dirname(directory);
    }
    if (fs.existsSync(path.join(directory, "web", "package.json"))) {
      return directory;
    }

    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return start;
}
