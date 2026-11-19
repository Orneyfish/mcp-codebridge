import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { tmpHome } from "./helpers.ts";
import { paths } from "../src/paths.ts";
import { loadServers, saveServers, resolveVars, toIdent, namespaceOf } from "../src/config.ts";

test("toIdent", () => {
  assert.equal(toIdent("claude.ai Gmail"), "claude_ai_gmail");
  assert.equal(toIdent("list-deployments"), "list_deployments");
  assert.equal(toIdent("3d"), "_3d");
});

test("namespaceOf uses alias", () => {
  assert.equal(namespaceOf("X", { command: "a", alias: "y" }), "y");
  assert.equal(namespaceOf("My Server", { command: "a" }), "my_server");
});

test("resolveVars", () => {
  assert.deepEqual(resolveVars({ A: "Bearer ${TOK}", B: "plain" }, { TOK: "t" }), { A: "Bearer t", B: "plain" });
  assert.deepEqual(resolveVars(undefined, {}), {});
  assert.throws(() => resolveVars({ A: "${TOK}" }, { OTHER: "val-xyz" }), (e: Error) => e.message.includes("TOK") && !e.message.includes("val-xyz"));
});

test("load/save round trip, 0600, missing → {}", () => {
  tmpHome();
  assert.deepEqual(loadServers(), {});
  const s = { a: { command: "x", args: ["1"], env: { K: "v" } }, b: { type: "http" as const, url: "https://h/mcp", headers: { H: "1" }, alias: "bb" } };
  saveServers(s);
  assert.deepEqual(loadServers(), s);
  assert.equal(statSync(paths().serversFile).mode & 0o777, 0o600);
});

test("invalid entry names the server", () => {
  tmpHome();
  mkdirSync(dirname(paths().serversFile), { recursive: true });
  writeFileSync(paths().serversFile, JSON.stringify({ mcpServers: { broken: { args: [] } } }));
  assert.throws(() => loadServers(), /broken/);
});
