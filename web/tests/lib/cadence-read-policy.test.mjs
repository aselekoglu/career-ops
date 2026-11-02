import assert from "node:assert/strict";
import test from "node:test";
import { readCadenceWithPolicy } from "../../src/lib/cadence-read-policy.mjs";

test("cloud without database fails closed before any local or data read", async () => {
  const calls = [];
  const result = await readCadenceWithPolicy({
    databaseConfigured: false,
    cloudRuntime: true,
    readNeon: () => calls.push("neon"),
    readLocal: () => calls.push("local"),
    cloudDisabled: () => ({ status: 501 }),
  });
  assert.deepEqual(result, { status: 501 });
  assert.deepEqual(calls, []);
});

test("cloud with database reads the Neon snapshot", async () => {
  const calls = [];
  const result = await readCadenceWithPolicy({
    databaseConfigured: true,
    cloudRuntime: true,
    readNeon: () => { calls.push("neon"); return "snapshot"; },
    readLocal: () => { calls.push("local"); return "disk"; },
    cloudDisabled: () => null,
  });
  assert.equal(result, "snapshot");
  assert.deepEqual(calls, ["neon"]);
});

test("local with database keeps using the Neon snapshot", async () => {
  const result = await readCadenceWithPolicy({
    databaseConfigured: true,
    cloudRuntime: false,
    readNeon: () => "snapshot",
    readLocal: () => "disk",
    cloudDisabled: () => null,
  });
  assert.equal(result, "snapshot");
});

test("local without database keeps using local files", async () => {
  const result = await readCadenceWithPolicy({
    databaseConfigured: false,
    cloudRuntime: false,
    readNeon: () => "snapshot",
    readLocal: () => "disk",
    cloudDisabled: () => null,
  });
  assert.equal(result, "disk");
});
