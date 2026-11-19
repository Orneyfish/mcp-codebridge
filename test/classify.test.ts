import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../src/gate/classify.ts";

test("classify", () => {
  assert.equal(classify({ name: "get_user" }), "read");
  assert.equal(classify({ name: "getUser" }), "read");
  assert.equal(classify({ name: "list" }), "read");
  assert.equal(classify({ name: "listings_create" }), "write");
  assert.equal(classify({ name: "stats" }), "write");
  assert.equal(classify({ name: "do_x", annotations: { readOnlyHint: true } }), "read");
  assert.equal(classify({ name: "get_x", annotations: { destructiveHint: true } }), "write");
  assert.equal(classify({ name: "get_x", annotations: { readOnlyHint: false } }), "write");
  assert.equal(classify({ name: "get_x" }, "write"), "write");
  assert.equal(classify({ name: "make_thing" }, "read"), "read");
  assert.equal(classify({ name: "make_thing" }), "write");
});
