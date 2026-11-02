import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync(new URL("../../src/app/api/status/route.ts", import.meta.url), "utf8");
const proxy = readFileSync(new URL("../../src/proxy.ts", import.meta.url), "utf8");

test("cloud status POST remains behind Basic auth and is allowed by the proxy", () => {
  const authGate = proxy.indexOf("if (!isAuthorized(request, credentials))");
  const statusAllow = proxy.indexOf("pathname === '/api/status'");
  assert.ok(authGate >= 0 && statusAllow > authGate, "status route must stay behind Basic auth");
  assert.match(proxy, /pathname === '\/api\/status'.*request\.method === 'POST'/);
});

test("status route writes through Neon management in hosted mode, not local filesystem", () => {
  const cloudBranch = route.indexOf("if (cloudDataEnabled())");
  const cloudMutation = route.indexOf('handleCloudTrackerCommand(command, "tracker")');
  const localWrite = route.indexOf("atomicWrite(file, lines.join");
  assert.ok(cloudBranch >= 0 && cloudMutation > cloudBranch, "cloud branch must call durable tracker mutation");
  assert.ok(localWrite > cloudMutation, "filesystem write must remain a local-mode fallback only");
  assert.match(route, /if \(!result\.ok\) return result;/);
});
