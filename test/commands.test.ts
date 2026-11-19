import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpHome } from "./helpers.ts";
import { paths } from "../src/paths.ts";
import { loadServers, saveServers } from "../src/config.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { Upstreams } from "../src/upstream/manager.ts";
import { importServers, verify, status } from "../src/commands.ts";

const FIXTURE = new URL("./fixtures/fixture-server.ts", import.meta.url).pathname;
const TOOLS = JSON.parse(readFileSync(new URL("./fixtures/tools.json", import.meta.url), "utf8"));
const cleanup: (() => unknown)[] = [];
after(async () => { for (const f of cleanup) await f(); });

test("importServers copies top-level mcpServers, skips codebridge/existing, never writes claude.json", () => {
  const root = tmpHome();
  const cj = join(root, "claude.json");
  writeFileSync(cj, JSON.stringify({ mcpServers: { a: { type: "stdio", command: "x", env: { K: "secret" } }, codebridge: { command: "y" }, keep: { command: "new" } }, projects: { "/p": { mcpServers: { p: { command: "z" } } } } }));
  saveServers({ keep: { command: "old" } });
  const before = { bytes: readFileSync(cj, "utf8"), mtime: statSync(cj).mtimeMs };
  const r = importServers(cj);
  assert.deepEqual(r, { added: ["a"], skipped: ["codebridge", "keep"] });
  const s = loadServers();
  assert.equal((s.a as any).env.K, "secret");
  assert.equal((s.keep as any).command, "old");
  assert.equal(statSync(paths().serversFile).mode & 0o777, 0o600);
  assert.equal(readFileSync(cj, "utf8"), before.bytes);
  assert.equal(statSync(cj).mtimeMs, before.mtime);
});

test("status redacts secrets and flags stale servers", () => {
  tmpHome();
  const servers = {
    s: { command: "x", env: { K: "secret-env" } },
    h: { type: "http" as const, url: "https://host.example/mcp?key=secret-q", headers: { Authorization: "Bearer secret-hdr" } },
  };
  const c = new Catalog();
  c.markServer("s", "up");
  c.markServer("h", "stale", "fetch failed for https://host.example/mcp?key=secret-q");
  const out = status(c, servers);
  assert.ok(!/secret/.test(out), out);
  assert.match(out, /h \(http https:\/\/host\.example\/mcp\) stale: .* — keep the direct entry/);
  assert.match(out, /auto mode/);
  assert.match(out, /mcp__codebridge__approve/);
});

test("verify compares counts and runs one read call", async () => {
  tmpHome();
  const servers = { fx: { command: process.execPath, args: [FIXTURE] } };
  const catalog = new Catalog();
  catalog.syncServer("fx", "fx", TOOLS);
  const upstreams = new Upstreams(servers);
  cleanup.push(() => upstreams.close());
  const r = await verify("fx", { servers, catalog, upstreams });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.includes("9 = 9")));
  assert.ok(r.lines.some((l) => /read call fx\.list_items: ok/.test(l)));
  const bad = await verify("fx", { servers, catalog: (catalog.syncServer("fx", "fx", TOOLS.slice(1)), catalog), upstreams });
  assert.equal(bad.ok, false);
});
