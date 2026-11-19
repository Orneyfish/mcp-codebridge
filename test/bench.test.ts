import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, judge } from "../bench/run.ts";

const events = [
  { type: "system", subtype: "init" },
  { type: "assistant", message: { content: [{ type: "text", text: "x" }, { type: "tool_use", name: "mcp__codebridge__search" }] } },
  { type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: '{"status":"completed"}' }] }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__codebridge__execute" }] } },
  { type: "user", message: { content: [{ type: "tool_result", content: '{"status":"paused","run_id":"a"}' }] } },
  { type: "result", result: "Profiles: Quiet, Balanced", usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 } },
];

test("summarize sums usage, counts tool calls, detects pauses", () => {
  assert.deepEqual(summarize(events), { tokens: 1115, input: 1110, output: 5, toolCalls: 2, paused: true, answer: "Profiles: Quiet, Balanced" });
});

test("summarize with no result event", () => {
  assert.equal(summarize([{ type: "system" }]).answer, "");
});

test("judge: all expected substrings, case-insensitive, and no pause", () => {
  assert.equal(judge({ answer: "quiet and BALANCED", paused: false }, ["Quiet", "balanced"]), true);
  assert.equal(judge({ answer: "quiet", paused: false }, ["Quiet", "balanced"]), false);
  assert.equal(judge({ answer: "quiet balanced", paused: true }, ["Quiet"]), false);
});
