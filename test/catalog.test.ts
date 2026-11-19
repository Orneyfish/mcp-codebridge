import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpHome } from "./helpers.ts";
import { paths } from "../src/paths.ts";
import { Catalog } from "../src/catalog/catalog.ts";

const TOOLS = JSON.parse(readFileSync(new URL("./fixtures/tools.json", import.meta.url), "utf8"));

function fresh() { tmpHome(); const c = new Catalog(); c.syncServer("fx", "fx", TOOLS); return c; }

test("search ranks and tags", () => {
  const c = fresh();
  const lines = c.search("delete");
  assert.match(lines[0], /^fx\.delete_item — .*\[write\]$/);
  assert.match(c.search("get item")[0], /^fx\.get_item — Get one item by id\. \[read\]$/);
  assert.equal(c.search("").length, 9);
});

test("describe", () => {
  const c = fresh();
  const d = c.describe(["fx.get_item", "fx.nope"]);
  assert.match(d, /^\/\/ fx$/m);
  assert.ok(d.includes("get_item(args: { id: string })"));
  assert.ok(d.includes("// not found: fx.nope"));
});

test("resync reports changes, removes tools, keeps idents", () => {
  const c = fresh();
  const t2 = TOOLS.filter((t: any) => t.name !== "slow").map((t: any) => t.name === "get_item" ? { ...t, description: "Changed." } : t);
  const r = c.syncServer("fx", "fx", t2);
  assert.deepEqual(r.changed, ["get_item"]);
  assert.equal(c.resolve("fx", "slow"), undefined);
  assert.deepEqual(c.resolve("fx", "get_item"), { server: "fx", tool: "get_item", access: "read" });
  assert.equal(c.resolve("fx", "make_thing")!.access, "write");
});

test("override changes access", () => {
  const c = fresh();
  c.syncServer("fx", "fx", TOOLS, { make_thing: { access: "read" } });
  assert.equal(c.resolve("fx", "make_thing")!.access, "read");
});

test("model verdicts: unclassified, setModelAccess, kept while hash unchanged", () => {
  const c = fresh();
  const un = c.unclassified().map((t) => t.name).sort();
  assert.deepEqual(un, ["crash", "echo_env", "fail_tool", "image_tool", "make_thing", "slow"]);
  assert.equal(c.resolve("fx", "slow")!.access, "write");
  assert.ok(c.unclassified()[0].decl.includes("Promise<"));
  c.setModelAccess("fx", "slow", "read");
  assert.equal(c.resolve("fx", "slow")!.access, "read");
  c.syncServer("fx", "fx", TOOLS);
  assert.equal(c.resolve("fx", "slow")!.access, "read");
  assert.ok(!c.unclassified().some((t) => t.name === "slow"));
  c.syncServer("fx", "fx", TOOLS.map((t: any) => t.name === "slow" ? { ...t, description: "Sleep longer." } : t));
  assert.equal(c.resolve("fx", "slow")!.access, "write");
  c.syncServer("fx", "fx", TOOLS, { slow: { access: "read" } });
  assert.ok(!c.unclassified().some((t) => t.name === "slow"));
});

test("learned result shapes show in describe, not in check declarations; reset on change", () => {
  const c = fresh();
  c.learnShape("fx", "get_item", { id: "7", name: "item 7", auth: false });
  assert.match(c.describe(["fx.get_item"]), /get_item\(args: \{ id: string \}\): Promise<\{ id: string; name: string; auth: boolean \}>;/);
  assert.match(c.checkDeclarations(), /get_item\(args: \{ id: string \}\): Promise<any>;/);
  c.learnShape("fx", "get_item", "short");
  assert.match(c.describe(["fx.get_item"]), /Promise<\{ id: string/, "a less informative shape does not replace a richer one");
  c.learnShape("fx", "list_items", { other: 1 });
  assert.match(c.describe(["fx.list_items"]), /Promise<\{ items: \{ id: string; blob: string \}\[\] \}>/, "outputSchema wins");
  c.syncServer("fx", "fx", TOOLS.map((t: any) => t.name === "get_item" ? { ...t, description: "Changed." } : t));
  assert.match(c.describe(["fx.get_item"]), /Promise<unknown>;/);
});

test("tool ident collision keeps first, reports second", () => {
  tmpHome();
  const c = new Catalog();
  const r = c.syncServer("s", "s", [{ name: "get-a", inputSchema: { type: "object" } }, { name: "get_a", inputSchema: { type: "object" } }]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /get_a/);
  assert.equal(c.resolve("s", "get_a")!.tool, "get-a");
});

test("namespace collision", () => {
  const c = fresh();
  const err = c.checkNamespace("other", "fx");
  assert.ok(err && err.includes("fx") && err.includes("other") && err.includes("alias"));
  assert.equal(c.checkNamespace("fx", "fx"), null);
});

test("usage boost", () => {
  tmpHome();
  const c = new Catalog();
  const t = (name: string) => ({ name, description: "Alpha thing.", inputSchema: { type: "object" } });
  c.syncServer("s", "s", [t("alpha_one"), t("alpha_two")]);
  for (let i = 0; i < 5; i++) c.logCall({ server: "s", tool: "alpha_two", ms: 1, bytes: 1, runId: "r" });
  c.recomputeUsage();
  assert.match(c.search("alpha")[0], /^s\.alpha_two/);
});

test("checkDeclarations", () => {
  const c = fresh();
  const d = c.checkDeclarations();
  assert.match(d, /^declare const fx: \{$/m);
  assert.ok(d.includes("get_item(args: { id: string }): Promise<any>;"));
});

test("meta and rules", () => {
  const c = fresh();
  c.set("k", "v");
  assert.equal(c.get("k"), "v");
  for (let i = 0; i < 6; i++) c.recordKeySizes("fx", "list_items", { blob: 3000, id: 5 });
  assert.equal(c.proposeRules(), 1);
  assert.equal(c.proposeRules(), 0);
  assert.deepEqual(c.dropKeys("fx", "list_items"), []);
  const [r] = c.rules("proposed");
  assert.equal(r.key, "blob");
  c.setRule(r.id, "accepted");
  assert.deepEqual(c.dropKeys("fx", "list_items"), ["blob"]);
});

test("catalog concurrent writers", { timeout: 30_000 }, async () => {
  fresh();
  const src = new URL("../src/catalog/catalog.ts", import.meta.url).pathname;
  const script = `import { Catalog } from ${JSON.stringify(src)}; const c = new Catalog(); for (let i = 0; i < 500; i++) c.logCall({ server: "fx", tool: "t", ms: 1, bytes: 1, runId: "r" });`;
  const { spawn } = await import("node:child_process");
  const codes = await Promise.all([0, 1, 2].map(() => new Promise<number>((res) => {
    spawn(process.execPath, ["--input-type=module", "-e", script], { env: process.env, stdio: "inherit" }).on("close", (c) => res(c ?? 1));
  })));
  assert.deepEqual(codes, [0, 0, 0]);
  const n = execFileSync(process.execPath, ["-e", `const {DatabaseSync}=require("node:sqlite");console.log(new DatabaseSync(${JSON.stringify(paths().catalogDb)}).prepare("select count(*) n from calls").get().n)`]).toString().trim();
  assert.equal(n, "1500");
});

test("openDb adds the learned column to an existing catalog", async () => {
  tmpHome();
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(paths().dataDir, { recursive: true });
  const old = new DatabaseSync(join(paths().dataDir, "old.db"));
  old.exec("CREATE TABLE tools(id INTEGER PRIMARY KEY, server TEXT NOT NULL, name TEXT NOT NULL, ident TEXT NOT NULL, ns TEXT NOT NULL, summary TEXT, description TEXT, decl TEXT, check_decl TEXT, access TEXT, access_src TEXT, hash TEXT, usage REAL DEFAULT 0, UNIQUE(server, name))");
  old.close();
  const { openDb } = await import("../src/catalog/db.ts");
  const c = new Catalog(openDb(join(paths().dataDir, "old.db")));
  c.syncServer("fx", "fx", TOOLS);
  c.learnShape("fx", "get_item", { id: "1" });
  assert.match(c.describe(["fx.get_item"]), /Promise<\{ id: string \}>/);
});
