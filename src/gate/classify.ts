// Design §5.5 as amended by the user: override → annotations → (model verdict, see model-classify.ts) → write.
// No name guessing: undefined means "not decided here".
export function classify(
  tool: { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } },
  override?: "read" | "write",
): "read" | "write" | undefined {
  if (override) return override;
  const a = tool.annotations ?? {};
  if (a.destructiveHint === true || a.readOnlyHint === false) return "write";
  if (a.readOnlyHint === true) return "read";
  return undefined;
}
