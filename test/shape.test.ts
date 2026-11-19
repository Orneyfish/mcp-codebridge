import { test } from "node:test";
import assert from "node:assert/strict";
import { utimesSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpHome } from "./helpers.ts";
import { paths } from "../src/paths.ts";
import { Stash } from "../src/stash.ts";
import { toScriptValue, trim, cap, keySizes } from "../src/shape.ts";

const st = () => { tmpHome(); return new Stash(); };
const B64 = "QUJD".repeat(750); // 3000 chars

test("toScriptValue", () => {
  const s = st();
  const txt = (t: string) => ({ type: "text" as const, text: t });
  assert.deepEqual(toScriptValue({ content: [txt('{"a":1}')] }, s), { a: 1 });
  assert.equal(toScriptValue({ content: [txt("hello")] }, s), "hello");
  assert.deepEqual(toScriptValue({ content: [txt("x")], structuredContent: { k: 2 } }, s), { k: 2 });
  const img = toScriptValue({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }, s) as any;
  assert.equal(img.type, "image");
  assert.equal(img.mimeType, "image/png");
  assert.equal(s.get(img.stashId), "AAAA");
  assert.throws(() => toScriptValue({ content: [txt("nope")], isError: true }, s), /^Error: nope$/);
  assert.equal(toScriptValue({ content: [] }, s), null);
  assert.deepEqual(toScriptValue({ content: [txt("a"), txt("b")] }, s), ["a", "b"]);
});

test("trim", () => {
  const s = st();
  assert.deepEqual(trim({ a: null, b: "", c: [], d: {}, e: 1 }, [], s), { e: 1 });
  assert.deepEqual(trim({ x: { y: null, z: 2 } }, [], s), { x: { z: 2 } });
  const t = trim({ img: B64 }, [], s) as any;
  assert.equal(t.img.bytes, 3000);
  assert.equal(s.get(t.img.stashId), B64);
  const prose = "word ".repeat(600);
  assert.equal((trim({ p: prose }, [], s) as any).p, prose);
  assert.deepEqual(trim({ items: [{ id: 1, blob: "x" }] }, ["blob"], s), { items: [{ id: 1 }] });
  assert.deepEqual(trim([{ id: 1, blob: "x" }], ["blob"], s), [{ id: 1 }]);
  assert.deepEqual(trim({ blob: "x", id: 1 }, ["blob"], s), { id: 1 });
});

test("cap", () => {
  const s = st();
  const big = "x".repeat(20000);
  const r = cap(big, s) as any;
  assert.equal(r.value.truncated, true);
  assert.ok(r.stashed);
  assert.equal(r.value.stashId, r.stashed);
  assert.equal(r.value.preview.length, 1000);
  assert.equal(s.get(r.stashed), big);
  assert.deepEqual(cap({ a: 1 }, s), { value: { a: 1 } });
});

test("deep nesting does not throw", () => {
  const s = st();
  let v: any = { leaf: 1 };
  for (let i = 0; i < 5000; i++) v = { n: v };
  const t = trim(v, [], s);
  assert.ok(t);
  assert.ok(cap(t, s));
});

test("keySizes", () => {
  assert.deepEqual(keySizes({ a: "xx", b: 1 }), { a: 4, b: 1 });
  assert.deepEqual(keySizes({ items: [{ id: 1, blob: "xx" }, { id: 2, blob: "yy" }] }), { id: 2, blob: 8 });
  assert.deepEqual(keySizes("str"), {});
  assert.deepEqual(keySizes({ data: { big: "x" }, tags: ["a"] }), { tags: 5 });
});

test("stash bad id", () => {
  const s = st();
  assert.throws(() => s.get("../x"), /not found or expired/);
  assert.throws(() => s.get("deadbeef"), /not found or expired/);
});

test("sweep", () => {
  const s = st();
  const id = s.put({ a: 1 });
  s.put({ b: 2 });
  const old = (Date.now() - 2 * 86400_000) / 1000;
  utimesSync(join(paths().stashDir, `${id}.json`), old, old);
  assert.equal(s.sweep(), 1);
  assert.equal(readdirSync(paths().stashDir).length, 1);
});
