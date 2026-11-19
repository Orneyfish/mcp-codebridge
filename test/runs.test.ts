import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpHome } from "./helpers.ts";
import { paths } from "../src/paths.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { Upstreams } from "../src/upstream/manager.ts";
import { DenoExecutor } from "../src/sandbox/deno.ts";
import { Stash } from "../src/stash.ts";
import { Runs } from "../src/runs.ts";

const FIXTURE = new URL("./fixtures/fixture-server.ts", import.meta.url).pathname;
const TOOLS = JSON.parse(readFileSync(new URL("./fixtures/tools.json", import.meta.url), "utf8"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const live: Runs[] = [];
after(() => live.forEach((r) => r.close()));

function setup(extra: Partial<ConstructorParameters<typeof Runs>[0]> = {}) {
  const root = tmpHome();
  const fxLog = join(root, "fixture.log");
  const catalog = new Catalog();
  catalog.syncServer("fx", "fx", TOOLS);
  const upstreams = new Upstreams({ fx: { command: process.execPath, args: [FIXTURE], env: { FIXTURE_LOG: fxLog } } });
  const runs = new Runs({ executor: new DenoExecutor(), catalog, upstreams, stash: new Stash(), ...extra });
  live.push(runs);
  const count = (tool: string) => existsSync(fxLog) ? readFileSync(fxLog, "utf8").split("\n").filter((l) => l === tool).length : 0;
  const audit = () => existsSync(paths().auditLog) ? readFileSync(paths().auditLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { runs, upstreams, count, audit, catalog };
}

test("read runs freely, trimmed", async () => {
  const { runs, upstreams } = setup();
  const o: any = await runs.execute('return await fx.get_item({id:"7"})');
  assert.equal(o.status, "completed", JSON.stringify(o));
  assert.equal(o.result.name, "item 7");
  assert.ok(!("empty" in o.result));
  assert.deepEqual(o.result.tags, []);
  await upstreams.close();
});

test("read calls teach the catalog their result shape", async () => {
  const { runs, upstreams, catalog } = setup();
  await runs.execute('return (await fx.get_item({id:"7"})).name');
  assert.match(catalog.describe(["fx.get_item"]), /Promise<\{ id: string; name: string; tags: unknown\[\]; auth: boolean \}>/);
  await upstreams.close();
});

test("write pauses; yes executes once; audited", async () => {
  const { runs, upstreams, count, audit } = setup();
  const p: any = await runs.execute('await fx.delete_item({id:"1"}); return "done"');
  assert.equal(p.status, "paused");
  assert.deepEqual(p.pending, { server: "fx", tool: "delete_item", args: { id: "1" } });
  assert.equal(count("delete_item"), 0);
  const o: any = await runs.approve(p.run_id, "yes");
  assert.equal(o.status, "completed");
  assert.equal(o.result, "done");
  assert.equal(count("delete_item"), 1);
  const a = audit();
  assert.equal(a.length, 1);
  assert.equal(a[0].decision, "approved");
  assert.equal(a[0].via, "approve");
  assert.equal(statSync(paths().auditLog).mode & 0o777, 0o600);
  await upstreams.close();
});

test("no throws ApprovalDenied", async () => {
  const { runs, upstreams, count } = setup();
  const p: any = await runs.execute('try { await fx.delete_item({id:"1"}) } catch (e) { return e.message }');
  const o: any = await runs.approve(p.run_id, "no");
  assert.equal(o.status, "completed");
  assert.match(o.result, /ApprovalDenied/);
  assert.equal(count("delete_item"), 0);
  await upstreams.close();
});

test("unknown tool is write", async () => {
  const { runs, upstreams } = setup();
  assert.equal((await runs.execute("return await fx.make_thing({})")).status, "paused");
  await upstreams.close();
});

test("elicitation path and fallback", async () => {
  let s = setup({ elicit: async () => true });
  const o: any = await s.runs.execute('return await fx.delete_item({id:"1"})');
  assert.equal(o.status, "completed");
  assert.equal(s.audit()[0].via, "elicitation");
  await s.upstreams.close();
  s = setup({ elicit: async () => { throw new Error("x"); } });
  assert.equal((await s.runs.execute('return await fx.delete_item({id:"1"})')).status, "paused");
  await s.upstreams.close();
});

test("writes serialised", async () => {
  const { runs, upstreams, count } = setup();
  const p1: any = await runs.execute('return await Promise.all([fx.delete_item({id:"1"}), fx.delete_item({id:"2"})])');
  assert.equal(p1.status, "paused");
  const p2: any = await runs.approve(p1.run_id, "yes");
  assert.equal(p2.status, "paused");
  assert.equal(count("delete_item"), 1);
  const o: any = await runs.approve(p2.run_id, "yes");
  assert.equal(o.status, "completed");
  assert.deepEqual(o.result, ["deleted 1", "deleted 2"]);
  await upstreams.close();
});

test("paused clock does not count toward timeout", async () => {
  const { runs, upstreams } = setup();
  const p: any = await runs.execute('await fx.delete_item({id:"1"}); return 1', 500);
  await sleep(1000);
  assert.equal((await runs.approve(p.run_id, "yes")).status, "completed");
  await upstreams.close();
});

test("pause expiry", async () => {
  const { runs, upstreams, audit, count } = setup({ pauseTtlMs: 300 });
  const p: any = await runs.execute('await fx.delete_item({id:"1"})');
  await sleep(500);
  await assert.rejects(runs.approve(p.run_id, "yes"), /unknown or expired/);
  assert.equal(audit()[0].via, "expired");
  assert.equal(count("delete_item"), 0);
  await upstreams.close();
});

test("approve twice / unknown id", async () => {
  const { runs, upstreams, count } = setup();
  const p: any = await runs.execute('await fx.delete_item({id:"1"}); return 1');
  await runs.approve(p.run_id, "yes");
  await assert.rejects(runs.approve(p.run_id, "yes"), /unknown or expired/);
  await assert.rejects(runs.approve("nope", "yes"), /unknown or expired/);
  assert.equal(count("delete_item"), 1);
  await upstreams.close();
});

test("result capped and stash readable", async () => {
  const { runs, upstreams } = setup();
  const o: any = await runs.execute('return "x".repeat(20000)');
  assert.ok(o.stashed);
  const o2: any = await runs.execute(`return (await stash.get(${JSON.stringify(o.stashed)})).length`);
  assert.equal(o2.result, 20000);
  await upstreams.close();
});

test("upstream failures surface in script", async () => {
  const { runs, upstreams, catalog } = setup();
  catalog.syncServer("fx", "fx", TOOLS, { fail_tool: { access: "read" }, crash: { access: "read" } });
  const o: any = await runs.execute('const r = []; try { await fx.fail_tool({}) } catch (e) { r.push(e.message) } try { await fx.crash({}) } catch (e) { r.push(e.message) } return r');
  assert.equal(o.result[0], "nope");
  assert.match(o.result[1], /^fx: /);
  await upstreams.close();
});

test("call log and key sizes recorded", async () => {
  const { runs, upstreams, catalog } = setup();
  await runs.execute("return (await fx.list_items({})).items.length");
  assert.equal(catalog.db.prepare("select count(*) n from calls where tool='list_items'").get()!.n, 1);
  assert.equal(catalog.db.prepare("select total from key_sizes where key='blob'").get()!.total, 5 * 3002);
  await upstreams.close();
});
