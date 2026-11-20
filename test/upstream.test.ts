import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { Upstreams } from "../src/upstream/manager.ts";

export const FIXTURE = new URL("./fixtures/fixture-server.ts", import.meta.url).pathname;
const fx = { command: process.execPath, args: [FIXTURE] };
const kids: ChildProcess[] = [];
after(() => kids.forEach((k) => k.kill()));

async function serveFixture(mode: "--http" | "--sse"): Promise<number> {
  const p = spawn(process.execPath, [FIXTURE, mode, "0"], { stdio: ["ignore", "pipe", "inherit"] });
  kids.push(p);
  return new Promise((res) => p.stdout!.on("data", (d) => { const m = /listening (\d+)/.exec(String(d)); if (m) res(Number(m[1])); }));
}
const textOf = (r: any) => r.content[0].text;

test("stdio lazily starts", async () => {
  const u = new Upstreams({ fx });
  assert.equal(u.state("fx"), "idle");
  assert.equal((await u.listTools("fx")).length, 9);
  assert.equal(u.state("fx"), "up");
  await u.close();
});

test("env passed through with ${VAR}", async () => {
  process.env.CB_T = "abc";
  const u = new Upstreams({ fx: { ...fx, env: { FIXTURE_SECRET: "${CB_T}" } } });
  assert.equal(textOf(await u.callTool("fx", "echo_env", {})), "abc");
  await u.close();
});

test("restart once, then failed", async () => {
  const u = new Upstreams({ fx });
  await assert.rejects(u.callTool("fx", "crash", {}));
  assert.match(textOf(await u.callTool("fx", "get_item", { id: "1" })), /item 1/);
  await assert.rejects(u.callTool("fx", "crash", {}));
  await assert.rejects(u.callTool("fx", "get_item", { id: "1" }), /^Error: fx: .*failed/);
  assert.equal(u.state("fx"), "failed");
  await u.close();
});

test("missing command", async () => {
  const u = new Upstreams({ bad: { command: "/nonexistent" } });
  await assert.rejects(u.listTools("bad"), (e: Error) => e.message.startsWith("bad: "));
  await u.close();
});

test("timeoutMs", async () => {
  const u = new Upstreams({ fx: { ...fx, timeoutMs: 200 } });
  await u.listTools("fx");
  const t = Date.now();
  await assert.rejects(u.callTool("fx", "slow", { ms: 1000 }), /^Error: fx: /);
  assert.ok(Date.now() - t < 1000);
  await u.close();
});

test("onDown: crash, timeout, missing command report; tool errors and server-side JSON-RPC errors don't", async () => {
  const down: string[] = [];
  const u = new Upstreams({ fx: { ...fx, timeoutMs: 200 }, bad: { command: "/nonexistent" } }, undefined, (s) => down.push(s));
  const r = await u.callTool("fx", "fail_tool", {});
  assert.equal(r.isError, true);
  await u.callTool("fx", "no_such_tool", {}).catch(() => {}); // server answers: unknown tool
  await u.callTool("fx", "get_item", {}).catch(() => {}); // server answers: invalid params
  assert.deepEqual(down, []);
  await assert.rejects(u.callTool("fx", "slow", { ms: 1000 }));
  assert.deepEqual(down, ["fx"]);
  await assert.rejects(u.callTool("fx", "crash", {}));
  await assert.rejects(u.listTools("bad"));
  assert.deepEqual(down, ["fx", "fx", "bad"]);
  await u.close();
});

for (const [mode, type] of [["--http", "http"], ["--sse", "sse"]] as const) {
  test(`${type} transport with headers`, async () => {
    const port = await serveFixture(mode);
    const u = new Upstreams({ h: { type, url: `http://127.0.0.1:${port}/${type === "http" ? "mcp" : "sse"}`, headers: { Authorization: "Bearer x" } } });
    assert.equal((await u.listTools("h")).length, 9);
    assert.equal(JSON.parse(textOf(await u.callTool("h", "get_item", { id: "2" }))).auth, true);
    await u.close();
  });
}
