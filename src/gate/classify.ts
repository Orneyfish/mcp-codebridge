const READ_NAME = /^(get|list|search|read|query|fetch|describe|count|find|stat)(?:[_\-.A-Z0-9]|$)/;

// Design §5.5: override → annotations → name heuristic → unknown = write.
export function classify(
  tool: { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } },
  override?: "read" | "write",
): "read" | "write" {
  if (override) return override;
  const a = tool.annotations ?? {};
  if (a.readOnlyHint === true && a.destructiveHint !== true) return "read";
  if (a.readOnlyHint === false || a.destructiveHint === true) return "write";
  return READ_NAME.test(tool.name) ? "read" : "write";
}
