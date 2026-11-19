import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpHome } from "./helpers.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { Upstreams } from "../src/upstream/manager.ts";
import { DenoExecutor } from "../src/sandbox/deno.ts";
import { Stash } from "../src/stash.ts";
import { Runs } from "../src/runs.ts";
import { recipeCalls, saveRecipe, recipePrelude, checkRecipes } from "../src/recipes.ts";

const FIXTURE = new URL("./fixtures/fixture-server.ts", import.meta.url).pathname;
const TOOLS = JSON.parse(readFileSync(new URL("./fixtures/tools.json", import.meta.url), "utf8"));
const cleanup: (() => unknown)[] = [];
after(async () => { for (const f of cleanup) await f(); });

function setup() {
  tmpHome();
  const catalog = new Catalog();
  catalog.syncServer("fx", "fx", TOOLS);
  return catalog;
}

test("recipeCalls only counts known namespaces", () => {
  const calls = recipeCalls("const r = []; r.push(1); await fx.get_item({}); args.items.map(x => x); x.fx.nope(); await  fx.list_items ({})", new Set(["fx"]));
  assert.deepEqual(calls, ["fx.get_item", "fx.list_items"]);
});

test("saveRecipe validates name and tools", () => {
  const c = setup();
  assert.throws(() => saveRecipe("Bad-Name", "return 1", "d", c), /name/);
  assert.throws(() => saveRecipe("ok_name", "return await fx.nope({})", "d", c), /fx\.nope/);
});

test("saved recipe is searchable and runs inside execute", async () => {
  const c = setup();
  assert.equal(saveRecipe("get7", "return await fx.get_item({id: args.id})", "Fetch an item by id", c), "saved recipes.get7");
  assert.match(c.search("get7")[0], /^recipes\.get7 — Fetch an item by id \[recipe\]$/);
  assert.match(c.describe(["recipes.get7"]), /get7\(args: any\)/);
  const upstreams = new Upstreams({ fx: { command: process.execPath, args: [FIXTURE] } });
  const runs = new Runs({ executor: new DenoExecutor(), catalog: c, upstreams, stash: new Stash(), recipePrelude: (code) => recipePrelude(code, c) });
  cleanup.push(() => runs.close(), () => upstreams.close());
  const o: any = await runs.execute("return (await recipes.get7({id:'7'})).name");
  assert.equal(o.result, "item 7", JSON.stringify(o));
  assert.match(recipePrelude("return 1", c), /^const recipes = \{\s*\};$/);
});

test("checkRecipes flags type errors and missing tools", { timeout: 60_000 }, () => {
  const c = setup();
  saveRecipe("good", "return await fx.get_item({id: String(args.id)})", "ok", c);
  saveRecipe("typo", "return await fx.get_item({wrong: 1})", "bad args", c);
  saveRecipe("uses_slow", "return await fx.slow({ms: 1})", "slow", c);
  c.syncServer("fx", "fx", TOOLS.filter((t: any) => t.name !== "slow"));
  const broken = checkRecipes(c);
  assert.deepEqual(broken.map((b) => b.name).sort(), ["typo", "uses_slow"]);
  assert.match(broken.find((b) => b.name === "uses_slow")!.reason, /missing fx\.slow/);
  assert.ok(!c.search("typo").length);
  assert.equal(c.recipes().find((r) => r.name === "good")!.status, "ok");
});
