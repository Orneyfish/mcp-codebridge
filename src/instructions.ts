const HEADER = `codebridge: call tools of many MCP servers by writing code.
1. search(query) → find tools/recipes as "ns.tool — summary [read|write|recipe]", with signatures of the top 3.
2. describe(names) → TypeScript signatures for any other ones you need.
3. execute(code) → async function body; call tools as await ns.tool({...}); return only what you need. Results over ~4k tokens are stashed: stash.get(id).
4. Writes pause for approval: if execute returns status "paused", call approve(run_id, "yes"|"no") only after the user agrees.
5. save_recipe(name, code, description) stores a working script; call it later as recipes.name(args).
Frequently used:`;

export function buildInstructions(top: string[]): string {
  let s = HEADER;
  for (const line of top) {
    if (s.length + 1 + line.length > 3500) break;
    s += "\n" + line;
  }
  return s;
}
