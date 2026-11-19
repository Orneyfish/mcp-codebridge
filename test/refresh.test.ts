import { test, after } from "node:test";
import assert from "node:assert/strict";
import { tmpHome } from "./helpers.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { Upstreams } from "../src/upstream/manager.ts";
import { Stash } from "../src/stash.ts";
import { refresh } from "../src/refresh.ts";
import { buildInstructions } from "../src/instructions.ts";
import type { ServerEntry } from "../src/config.ts";

const FIXTURE = new URL("./fixtures/fixture-server.ts", import.meta.url).pathname;
const cleanup: (() => unknown)[] = [];
after(async () => { for (const f of cleanup) await f(); });

// Fake model: everything named slow/echo_env is read, the rest write.
const ask = async (p: string) => JSON.stringify(Object.fromEntries([...p.matchAll(/^### (\S+)$/gm)].map((m) => [m[1], /slow|echo_env/.test(m[1]) ? "read" : "write"])));

function setup(servers: Record<string, ServerEntry>) {
  tmpHome();
  const catalog = new Catalog();
  const upstreams = new Upstreams(servers);
  cleanup.push(() => upstreams.close());
  return { catalog, upstreams, stash: new Stash(), servers };
}
const fx = { command: process.execPath, args: [FIXTURE] };

test("syncs up servers, keeps stale rows, classifies with the model", async () => {
  const d = setup({ fx, bad: { command: "/nonexistent" }, off: { command: "/x", disabled: true } });
  d.catalog.syncServer("bad", "bad", [{ name: "get_thing", inputSchema: { type: "object" } }]);
  const r = await refresh({ ...d, ask });
  assert.deepEqual(r.up, ["fx"]);
  assert.deepEqual(r.stale, ["bad"]);
  assert.ok(d.catalog.resolve("bad", "get_thing"));
  assert.equal(d.catalog.resolve("fx", "slow")!.access, "read");
  assert.equal(d.catalog.resolve("fx", "make_thing")!.access, "write");
  assert.equal(r.classified, 7); // 6 fixture + bad.get_thing
  assert.ok(!d.catalog.servers().some((s) => s.name === "off"));
});

test("model failure leaves tools as write and reports it", async () => {
  const d = setup({ fx });
  const r = await refresh({ ...d, ask: async () => { throw new Error("offline"); } });
  assert.equal(d.catalog.resolve("fx", "slow")!.access, "write");
  assert.ok(r.errors.some((e) => /offline/.test(e)));
});

test("servers removed from config lose their tools", async () => {
  const d = setup({ fx });
  d.catalog.syncServer("gone", "gone", [{ name: "x", inputSchema: { type: "object" } }]);
  await refresh({ ...d, ask });
  assert.equal(d.catalog.resolve("gone", "x"), undefined);
});

test("namespace collision skips both and names them", async () => {
  const d = setup({ "a b": fx, a_b: fx });
  const r = await refresh({ ...d, ask });
  assert.deepEqual(r.up, []);
  assert.ok(r.errors.some((e) => e.includes('"a b"') && e.includes('"a_b"') && e.includes("alias")));
});

test("rule proposals, instructions ranking, retention", async () => {
  const d = setup({ fx });
  await refresh({ ...d, ask });
  for (let i = 0; i < 6; i++) {
    d.catalog.logCall({ server: "fx", tool: "list_items", ms: 1, bytes: 1, runId: "r" });
    d.catalog.recordKeySizes("fx", "list_items", { blob: 3000 });
  }
  d.catalog.logCall({ server: "fx", tool: "get_item", ms: 1, bytes: 1, runId: "r" });
  d.catalog.db.prepare("INSERT INTO calls(ts, server, tool, ms, bytes, run_id) VALUES (?,?,?,?,?,?)").run(Date.now() - 40 * 86400_000, "fx", "slow", 1, 1, "old");
  const r = await refresh({ ...d, ask });
  assert.ok(r.proposed >= 1);
  assert.deepEqual(d.catalog.dropKeys("fx", "list_items"), []);
  const top = d.catalog.get("instructions_top")!.split("\n");
  assert.match(top[0], /^fx\.list_items — /);
  assert.equal(top.length, 2);
  assert.ok(buildInstructions(top).length <= 3500);
  assert.equal(d.catalog.db.prepare("SELECT count(*) n FROM calls WHERE run_id = 'old'").get()!.n, 0);
  assert.ok(JSON.parse(d.catalog.get("last_report")!).up);
});
