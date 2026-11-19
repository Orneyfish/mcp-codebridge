import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { tmpHome } from "./helpers.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { Upstreams } from "../src/upstream/manager.ts";
import { DenoExecutor } from "../src/sandbox/deno.ts";
import { Stash } from "../src/stash.ts";
import { Runs } from "../src/runs.ts";
import { createServer } from "../src/server.ts";
import { buildInstructions } from "../src/instructions.ts";

const FIXTURE = new URL("./fixtures/fixture-server.ts", import.meta.url).pathname;
const TOOLS = JSON.parse(readFileSync(new URL("./fixtures/tools.json", import.meta.url), "utf8"));
const cleanup: (() => unknown)[] = [];
after(async () => { for (const f of cleanup) await f(); });

async function connect(elicit?: (req: any) => any) {
  tmpHome();
  const catalog = new Catalog();
  catalog.syncServer("fx", "fx", TOOLS);
  const upstreams = new Upstreams({ fx: { command: process.execPath, args: [FIXTURE] } });
  const runs = new Runs({ executor: new DenoExecutor(), catalog, upstreams, stash: new Stash() });
  const server = createServer({ runs, catalog, saveRecipe: () => "saved" });
  const client = new Client({ name: "t", version: "1" }, elicit ? { capabilities: { elicitation: {} } } : {});
  if (elicit) client.setRequestHandler(ElicitRequestSchema, elicit);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  cleanup.push(() => runs.close(), () => upstreams.close(), () => client.close());
  const call = async (name: string, args: object) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { text: r.content[0].text as string, isError: !!r.isError };
  };
  return { client, call };
}

test("lists exactly five tools; footprint ≤ 4000 chars", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["approve", "describe", "execute", "save_recipe", "search"]);
  for (const t of tools) {
    assert.ok((t.description ?? "").length <= 200, t.name);
    assert.equal(t._meta?.["anthropic/alwaysLoad"], true, `${t.name} must not be deferred behind tool search`);
  }
  const total = JSON.stringify(tools).length + (client.getInstructions() ?? "").length;
  assert.ok(total <= 4000, `footprint ${total}`);
});

test("instructions ≤ 3500 and start with header", () => {
  const s = buildInstructions(Array.from({ length: 500 }, (_, i) => `fx.tool_${i} — ${"long summary ".repeat(5)} [read]`));
  assert.ok(s.length <= 3500, String(s.length));
  assert.ok(s.startsWith("codebridge: call tools of many MCP servers by writing code."));
  assert.ok(s.includes("Frequently used:\nfx.tool_0"));
});

test("search → describe → execute", async () => {
  const { call } = await connect();
  const found = (await call("search", { query: "get item" })).text;
  assert.match(found, /^fx\.get_item — /);
  assert.match(found, /\n\n\/\/ fx\n[\s\S]*get_item\(args: \{ id: string \}\)/, "top matches come with signatures");
  assert.equal(found.match(/\): Promise</g)!.length, 3, "signatures only for the top 3");
  assert.match((await call("describe", { names: ["fx.get_item"] })).text, /get_item\(args: \{ id: string \}\)/);
  const r = JSON.parse((await call("execute", { code: 'return (await fx.get_item({id:"7"})).name' })).text);
  assert.deepEqual(r, { status: "completed", result: "item 7", logs: [] });
});

test("execute paused → approve; unknown run is an error", async () => {
  const { call } = await connect();
  const p = JSON.parse((await call("execute", { code: 'return await fx.delete_item({id:"1"})' })).text);
  assert.equal(p.status, "paused");
  const o = JSON.parse((await call("approve", { run_id: p.run_id, decision: "yes" })).text);
  assert.deepEqual(o.result, "deleted 1");
  const bad = await call("approve", { run_id: "nope", decision: "yes" });
  assert.ok(bad.isError);
  assert.match(bad.text, /unknown or expired/);
});

test("elicitation accept runs; decline → ApprovalDenied", async () => {
  let action = "accept";
  const { call } = await connect(async () => ({ action }));
  const o = JSON.parse((await call("execute", { code: 'return await fx.delete_item({id:"1"})' })).text);
  assert.equal(o.status, "completed");
  action = "decline";
  const d = JSON.parse((await call("execute", { code: 'try { await fx.delete_item({id:"1"}) } catch (e) { return e.message }' })).text);
  assert.match(d.result, /ApprovalDenied/);
});
