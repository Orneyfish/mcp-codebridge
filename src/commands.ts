import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Catalog } from "./catalog/catalog.ts";
import { loadServers, saveServers, type ServerEntry } from "./config.ts";
import type { Upstreams } from "./upstream/manager.ts";

// Reads ~/.claude.json (never writes it) and copies its user-level mcpServers into servers.json (0600).
export function importServers(claudeJson = join(homedir(), ".claude.json")): { added: string[]; skipped: string[] } {
  const src: Record<string, ServerEntry> = JSON.parse(readFileSync(claudeJson, "utf8")).mcpServers ?? {};
  const current = loadServers();
  const added: string[] = [], skipped: string[] = [];
  for (const [name, e] of Object.entries(src)) {
    if (name === "codebridge" || name in current) { skipped.push(name); continue; }
    current[name] = e;
    added.push(name);
  }
  saveServers(current);
  loadServers(); // validate what was written
  return { added, skipped };
}

export async function verify(name: string, d: { servers: Record<string, ServerEntry>; catalog: Catalog; upstreams: Upstreams }): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;
  const direct = await d.upstreams.listTools(name);
  const inCatalog = d.catalog.allTools().filter((t) => t.server === name);
  const same = direct.length === inCatalog.length;
  ok &&= same;
  lines.push(`tools (catalog vs server): ${inCatalog.length} ${same ? "=" : "≠"} ${direct.length}${same ? "" : " — run codebridge refresh"}`);
  const reads = new Set(inCatalog.filter((t) => t.access === "read").map((t) => t.name));
  const probe = direct.find((t) => reads.has(t.name) && !(t.inputSchema.required ?? []).length);
  if (!probe) {
    lines.push("read call: no argument-free read tool; skipped");
  } else {
    const ns = inCatalog.find((t) => t.name === probe.name)!;
    try {
      const r = await d.upstreams.callTool(name, probe.name, {});
      ok &&= !r.isError;
      lines.push(`read call ${ns.ns}.${ns.ident}: ${r.isError ? "tool returned an error" : "ok"}`);
    } catch (e) {
      ok = false;
      lines.push(`read call ${ns.ns}.${ns.ident}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { ok, lines };
}

const noQuery = (s: string) => s.replace(/\?[^\s"')]*/g, "");

export function status(catalog: Catalog, servers: Record<string, ServerEntry>): string {
  const known = new Map(catalog.servers().map((s) => [s.name, s]));
  const out = ["servers:"];
  for (const [name, e] of Object.entries(servers)) {
    const where = "url" in e ? `${e.type} ${noQuery(e.url)}` : "stdio";
    const s = known.get(name);
    const st = e.disabled ? "disabled" : s?.status ?? "not refreshed yet";
    const reason = s?.reason ? `: ${noQuery(s.reason).slice(0, 200)}` : "";
    const keep = ["stale", "unsupported", "failed", "not refreshed yet"].includes(st) ? " — keep the direct entry" : "";
    out.push(`  ${name} (${where}) ${st}${reason}${keep}`);
  }
  const last = catalog.get("last_report");
  if (last) {
    const r = JSON.parse(last);
    out.push(`last refresh: ${r.at}; changed tools ${r.changed.length}; model-classified ${r.classified}; errors ${r.errors.length}`);
  } else out.push("last refresh: never (run codebridge refresh)");
  out.push(`tools treated as write until classified: ${catalog.unclassified().length}`);
  out.push(`pending trim-rule proposals: ${catalog.rules("proposed").length} (codebridge rules list)`);
  const broken = catalog.recipes().filter((r) => r.status === "broken");
  out.push(`broken recipes: ${broken.length ? broken.map((r) => r.name).join(", ") : "none"}`);
  out.push("Note: when elicitation is unavailable, approval relies on Claude Code's permission prompt for approve; in auto mode or if mcp__codebridge__approve is allow-listed, writes may run without a prompt.");
  return out.join("\n");
}
