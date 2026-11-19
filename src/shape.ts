import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Stash } from "./stash.ts";

const B64 = /^[A-Za-z0-9+/=\r\n_-]+$/;
const MAX_DEPTH = 200; // deeper values pass through untouched (no stack blow-up)
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length) || (isObj(v) && !Object.keys(v).length);

export function toScriptValue(r: CallToolResult, stash: Stash): unknown {
  const parts = (r.content ?? []).map((c: any) => {
    if (c.type === "text") return c.text as string;
    if (c.type === "image" || c.type === "audio") return { type: c.type, mimeType: c.mimeType, stashId: stash.put(c.data) };
    if (c.type === "resource" && "blob" in c.resource) return { type: "resource", uri: c.resource.uri, mimeType: c.resource.mimeType, stashId: stash.put(c.resource.blob) };
    if (c.type === "resource") return { type: "resource", uri: c.resource.uri, text: c.resource.text };
    return c;
  });
  if (r.isError) throw new Error(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join("\n"));
  if (r.structuredContent) return r.structuredContent;
  if (!parts.length) return null;
  if (parts.length > 1) return parts;
  const p = parts[0];
  if (typeof p !== "string") return p;
  try { return JSON.parse(p); } catch { return p; }
}

export function trim(v: unknown, dropKeys: string[], stash: Stash): unknown {
  const drop = new Set(dropKeys);
  const dropIn = (o: unknown) => isObj(o) ? Object.fromEntries(Object.entries(o).filter(([k]) => !drop.has(k))) : o;
  if (drop.size) {
    if (Array.isArray(v)) v = v.map(dropIn);
    else if (isObj(v)) v = Object.fromEntries(Object.entries(dropIn(v) as object).map(([k, x]) => [k, Array.isArray(x) ? x.map(dropIn) : x]));
  }
  const walk = (x: unknown, depth: number): unknown => {
    if (typeof x === "string") return x.length > 2048 && B64.test(x) ? { stashId: stash.put(x), bytes: x.length } : x;
    if (depth > MAX_DEPTH || !x || typeof x !== "object") return x;
    if (Array.isArray(x)) return x.map((i) => walk(i, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(x)) {
      const w = walk(val, depth + 1);
      if (!isEmpty(w)) out[k] = w;
    }
    return out;
  };
  return walk(v, 0);
}

export function cap(v: unknown, stash: Stash, maxChars = 16_000): { value: unknown; stashed?: string } {
  let s: string;
  try { s = JSON.stringify(v) ?? "null"; } catch { s = String(v); }
  if (s.length <= maxChars) return { value: v };
  const stashed = stash.put(v);
  return { value: { truncated: true, stashId: stashed, preview: s.slice(0, 1000) }, stashed };
}

// Sizes of leaf-ish keys (primitives or arrays of primitives) at top level and inside top-level arrays of objects.
export function keySizes(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const scan = (o: unknown) => {
    if (!isObj(o)) return;
    for (const [k, x] of Object.entries(o)) {
      if (isObj(x) || (Array.isArray(x) && x.some((i) => i && typeof i === "object"))) continue;
      out[k] = (out[k] ?? 0) + JSON.stringify(x).length;
    }
  };
  const roots = Array.isArray(v) ? v : [v];
  for (const r of roots) {
    scan(r);
    if (isObj(r)) for (const x of Object.values(r)) if (Array.isArray(x)) x.forEach(scan);
  }
  return out;
}
