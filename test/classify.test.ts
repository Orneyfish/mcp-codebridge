import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../src/gate/classify.ts";

test("classify: override → annotations → undefined (no name guessing)", () => {
  assert.equal(classify({ name: "get_user" }), undefined);
  assert.equal(classify({ name: "make_thing" }), undefined);
  assert.equal(classify({ name: "do_x", annotations: { readOnlyHint: true } }), "read");
  assert.equal(classify({ name: "get_x", annotations: { destructiveHint: true } }), "write");
  assert.equal(classify({ name: "get_x", annotations: { readOnlyHint: false } }), "write");
  assert.equal(classify({ name: "x", annotations: { readOnlyHint: true, destructiveHint: true } }), "write");
  assert.equal(classify({ name: "get_x", annotations: { readOnlyHint: true } }, "write"), "write");
  assert.equal(classify({ name: "make_thing" }, "read"), "read");
});
