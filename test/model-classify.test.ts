import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyWithModel } from "../src/gate/model-classify.ts";

const tools = Array.from({ length: 45 }, (_, i) => ({ server: "s", name: `t${i}`, decl: `/** tool ${i} */\nt${i}(args: {}): Promise<unknown>;` }));

test("batches ≤ 40, maps verdicts, sends metadata only", async () => {
  const prompts: string[] = [];
  const r = await classifyWithModel(tools, async (p) => {
    prompts.push(p);
    const ids = [...p.matchAll(/^### (\S+)$/gm)].map((m) => m[1]);
    return JSON.stringify(Object.fromEntries(ids.map((id) => [id, id.endsWith("t1") ? "read" : "write"])));
  });
  assert.equal(prompts.length, 2);
  assert.ok(prompts[0].includes("unsure") && prompts[0].includes("write"));
  assert.equal(r.get("s/t1"), "read");
  assert.equal(r.get("s/t2"), "write");
  assert.equal(r.size, 45);
});

test("invalid or missing verdicts are left out (stay write)", async () => {
  const r = await classifyWithModel(tools.slice(0, 3), async () => 'Sure! ```json\n{"s/t0":"read","s/t1":"maybe"}\n```');
  assert.deepEqual([...r], [["s/t0", "read"]]);
});

test("ask failure yields no verdicts and reports error", async () => {
  const errors: string[] = [];
  const r = await classifyWithModel(tools.slice(0, 2), async () => { throw new Error("no auth"); }, errors);
  assert.equal(r.size, 0);
  assert.match(errors[0], /no auth/);
});
