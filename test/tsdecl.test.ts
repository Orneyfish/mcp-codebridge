import { test } from "node:test";
import assert from "node:assert/strict";
import { schemaToTs, toolDecl } from "../src/catalog/tsdecl.ts";

test("schemaToTs", () => {
  assert.equal(schemaToTs({ type: "object", properties: { id: { type: "string" }, n: { type: "integer" } }, required: ["id"] }), "{ id: string; n?: number }");
  assert.equal(schemaToTs({ enum: ["a", "b"] }), '"a" | "b"');
  assert.equal(schemaToTs({ type: "array", items: { type: "string" } }), "string[]");
  assert.equal(schemaToTs({ type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } }), "(string | number)[]");
  assert.equal(schemaToTs({ $ref: "#/defs/x" }), "unknown");
  assert.equal(schemaToTs({ anyOf: [{ type: "string" }, { type: "null" }] }), "string | null");
  assert.equal(schemaToTs({ type: "object", properties: { "a-b": { type: "boolean" } } }), '{ "a-b"?: boolean }');
  assert.equal(schemaToTs({ type: "object", additionalProperties: { type: "number" } }), "Record<string, number>");
  assert.equal(schemaToTs({ type: "object", properties: {} }), "{}");
});

test("toolDecl", () => {
  const d = toolDecl("get_item", { name: "get_item", description: "Get one item. More text.", inputSchema: { type: "object", properties: { id: { type: "string", description: "Item id" } }, required: ["id"] } });
  assert.equal(d, "/** Get one item. More text.\n * id: Item id */\nget_item(args: { id: string }): Promise<unknown>;");
  const o = toolDecl("list", { name: "list", inputSchema: { type: "object" }, outputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } });
  assert.match(o, /list\(args: \{\}\): Promise<\{ n: number \}>;$/);
  assert.match(toolDecl("x", { name: "x", inputSchema: { type: "object" } }, "any"), /Promise<any>/);
});

import { shapeOf } from "../src/catalog/tsdecl.ts";

test("shapeOf: keys and types only, never values", () => {
  assert.equal(shapeOf({ result: { projects: [{ id: "prj_secret", name: "b" }], pagination: { count: 1 } } }),
    "{ result: { projects: { id: string; name: string }[]; pagination: { count: number } } }");
  assert.equal(shapeOf([{ a: 1 }, { b: "x" }]), "{ a?: number; b?: string }[]");
  assert.equal(shapeOf([]), "unknown[]");
  assert.equal(shapeOf("text"), "string");
  assert.equal(shapeOf(null), "null");
  assert.equal(shapeOf({ "prj_1": { x: 1 }, "my key": 2 }), "Record<string, unknown>", "data-like keys are not leaked");
  assert.equal(shapeOf({ a: { b: { c: { d: { e: { f: 1 } } } } } }), "{ a: { b: { c: { d: object } } } }");
  const wide = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`field_${i}`, { nested: { deeper: "x".repeat(5) } }]));
  assert.ok(shapeOf(wide).length <= 800, String(shapeOf(wide).length));
  assert.ok(!shapeOf({ result: { projects: [{ id: "prj_secret" }] } }).includes("prj_secret"));
});
