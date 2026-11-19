import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { DenoExecutor } from "../src/sandbox/deno.ts";

const ex = new DenoExecutor();
const run = (code: string, fns = {}, opts = {}) => ex.execute(code, fns, opts);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("returns value", async () => {
  assert.deepEqual(await run("return 1+1"), { result: 2, logs: [] });
});

test("accepts TypeScript", async () => {
  assert.equal((await run("const x: number = 3; return x")).result, 3);
});

test("undefined → null", async () => {
  const r = await run("return");
  assert.equal(r.result, null);
  assert.equal(r.error, undefined);
});

test("tool round trip", async () => {
  const r = await run("return await srv.echo({x:1})", { "srv.echo": async (a: unknown) => ({ got: a }) });
  assert.deepEqual(r.result, { got: { x: 1 } });
});

test("tool error surfaces", async () => {
  const r = await run("try { await srv.echo({}) } catch (e) { return e.message }", {
    "srv.echo": async () => { throw new Error("boom"); },
  });
  assert.equal(r.result, "boom");
});

test("concurrent calls", async () => {
  const fns = { "srv.slow": async (a: unknown) => { await sleep(50); return a; } };
  const r = await run("const t = Date.now(); const v = await Promise.all([1,2,3].map(i => srv.slow(i))); return {v, ms: Date.now() - t}", fns);
  const res = r.result as { v: number[]; ms: number };
  assert.deepEqual(res.v, [1, 2, 3]);
  assert.ok(res.ms < 140, `took ${res.ms}ms`);
});

test("logs captured", async () => {
  const r = await run('console.log("hi", {a:1}); return 0');
  assert.ok(r.logs?.includes('hi {"a":1}'), JSON.stringify(r.logs));
});

test("timeout", async () => {
  const t = Date.now();
  const r = await run("await new Promise(()=>{})", {}, { timeoutMs: 300 });
  assert.match(r.error ?? "", /timeout after 300ms/);
  assert.ok(Date.now() - t < 1500);
});

test("paused clock", async () => {
  const clock = { paused: true };
  const r = await run("return await srv.wait({})", { "srv.wait": async () => { await sleep(600); return "ok"; } }, { timeoutMs: 300, clock });
  assert.equal(r.result, "ok");
});

test("memory limit", { timeout: 25_000 }, async () => {
  const r = await run("const a=[]; while(true) a.push(new Array(1e6).fill(1))");
  assert.ok(r.error);
});

test("output cap", { timeout: 20_000 }, async () => {
  const r = await run("while(true) Deno.stdout.writeSync(new Uint8Array(1<<20))");
  assert.match(r.error ?? "", /output cap/);
});

test("call limit", async () => {
  const r = await run("let i = 0; try { for (; i < 300; i++) await srv.n({}) } catch (e) { return [i, e.message] }", { "srv.n": async () => 1 });
  assert.deepEqual(r.result, [200, "call limit (200) reached"]);
});

test("denied net/fs/env/run", async () => {
  const probes = [
    'await fetch("https://example.com")',
    'Deno.readTextFileSync("/etc/hostname")',
    'Deno.env.get("HOME")',
    'new Deno.Command("ls").outputSync()',
  ];
  for (const p of probes) {
    const r = await run(`try { ${p}; return "allowed" } catch (e) { return e.name }`);
    assert.match(String(r.result), /NotCapable|PermissionDenied/, p);
  }
});

test("secret env not leaked", async () => {
  process.env.CODEBRIDGE_TEST_SECRET = "s3cr3t";
  const r = await run('try { return Deno.env.toObject() } catch { return "denied" }');
  assert.equal(r.result, "denied");
});

test("syntax error", async () => {
  const r = await run("return (");
  assert.match(r.error ?? "", /SyntaxError|parse|Expected/i);
});

test("raw stdout lines go to logs", async () => {
  const r = await run('Deno.stdout.writeSync(new TextEncoder().encode("raw line\\n")); return 1');
  assert.equal(r.result, 1);
  assert.ok(r.logs?.includes("raw line"));
});

test("abort signal", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const r = await run("await new Promise(()=>{})", {}, { signal: ac.signal });
  assert.match(r.error ?? "", /aborted/);
});

test("prelude is injected", async () => {
  const r = await run("return helper()", {}, { prelude: "const helper = () => 42;" });
  assert.equal(r.result, 42);
});

test("no leftover processes", async () => {
  await sleep(200);
  let out = "";
  try { out = execSync("pgrep -af '^deno run --no-prompt'").toString(); } catch {}
  assert.equal(out.trim(), "");
});
