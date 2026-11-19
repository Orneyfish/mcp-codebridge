type S = Record<string, any>;

const key = (k: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k));
const wrap = (t: string) => (t.includes(" | ") || t.includes(" & ") ? `(${t})` : t);
const one = (s: string, max: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? t.slice(0, max - 1) + "…" : t; };

export function schemaToTs(schema: unknown, depth = 0): string {
  const s = schema as S;
  if (!s || typeof s !== "object" || depth > 8 || s.$ref) return "unknown";
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (Array.isArray(s.enum)) return s.enum.map((v: unknown) => JSON.stringify(v)).join(" | ");
  const alts = s.anyOf ?? s.oneOf;
  if (Array.isArray(alts)) return [...new Set(alts.map((a: unknown) => schemaToTs(a, depth + 1)))].join(" | ");
  if (Array.isArray(s.allOf)) return s.allOf.map((a: unknown) => wrap(schemaToTs(a, depth + 1))).join(" & ");
  if (Array.isArray(s.type)) return s.type.map((t: string) => schemaToTs({ ...s, type: t }, depth + 1)).join(" | ");
  switch (s.type) {
    case "string": return "string";
    case "number": case "integer": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "array": return `${wrap(schemaToTs(s.items, depth + 1))}[]`;
  }
  if (s.type === "object" || s.properties) {
    const props = Object.entries((s.properties ?? {}) as S);
    if (!props.length) {
      if (s.additionalProperties && typeof s.additionalProperties === "object") return `Record<string, ${schemaToTs(s.additionalProperties, depth + 1)}>`;
      return "{}";
    }
    const req = new Set<string>(s.required ?? []);
    return `{ ${props.map(([k, v]) => `${key(k)}${req.has(k) ? "" : "?"}: ${schemaToTs(v, depth + 1)}`).join("; ")} }`;
  }
  return "unknown";
}

export function toolDecl(ident: string, tool: { name: string; description?: string; inputSchema: unknown; outputSchema?: unknown }, fallbackReturn = "unknown"): string {
  const doc = [one(tool.description ?? "", 400)];
  for (const [k, v] of Object.entries(((tool.inputSchema as S)?.properties ?? {}) as S)) {
    if (v?.description) doc.push(` * ${k}: ${one(v.description, 120)}`);
  }
  const ret = tool.outputSchema ? schemaToTs(tool.outputSchema) : fallbackReturn;
  return `/** ${doc.join("\n")} */\n${ident}(args: ${schemaToTs(tool.inputSchema)}): Promise<${ret}>;`;
}
