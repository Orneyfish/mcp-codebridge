import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { toIdent } from "../config.ts";
import { classify } from "../gate/classify.ts";
import { openDb } from "./db.ts";
import { toolDecl } from "./tsdecl.ts";

type Access = "read" | "write";
type ToolLike = Pick<Tool, "name" | "description" | "inputSchema" | "outputSchema" | "annotations">;
export type ServerStatus = "up" | "stale" | "unsupported" | "failed";
export type Rule = { id: number; server: string; tool: string; key: string; status: string };

const summaryOf = (d = "") => {
  const first = d.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0];
  return first.length > 100 ? first.slice(0, 99) + "…" : first;
};
// Each term as a prefix match, OR-ed; bm25 rewards matching more of them.
const ftsQuery = (q: string) => q.split(/[^A-Za-z0-9]+/).filter(Boolean).map((t) => `"${t}"*`).join(" OR ");

export class Catalog {
  db: DatabaseSync;
  constructor(db: DatabaseSync = openDb()) { this.db = db; }

  private tx<T>(f: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const r = f(); this.db.exec("COMMIT"); return r; } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  syncServer(server: string, ns: string, tools: ToolLike[], overrides: Record<string, { access: Access }> = {}): { changed: string[]; errors: string[] } {
    const changed: string[] = [], errors: string[] = [];
    this.tx(() => {
      const existing = new Map<string, any>();
      for (const r of this.db.prepare("SELECT id, name, ident, hash, access_src FROM tools WHERE server = ?").all(server)) existing.set(r.name as string, r);
      const seen = new Set<string>();
      const identOwner = new Map<string, string>();
      for (const r of existing.values()) if (tools.some((t) => t.name === r.name)) identOwner.set(r.ident, r.name);
      for (const t of [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        const row = existing.get(t.name);
        const ident = row?.ident ?? toIdent(t.name);
        const owner = identOwner.get(ident);
        if (owner && owner !== t.name) { errors.push(`${server}: tool "${t.name}" maps to "${ident}", already used by "${owner}"; skipped`); continue; }
        identOwner.set(ident, t.name);
        seen.add(t.name);
        const decided = classify(t, overrides[t.name]?.access);
        const src = overrides[t.name] ? "override" : decided ? "annotation" : "default";
        const hash = createHash("sha256").update(JSON.stringify([t.name, t.description, t.inputSchema, t.outputSchema, t.annotations])).digest("hex");
        if (row && row.hash === hash) {
          if (decided || row.access_src !== "model") this.db.prepare("UPDATE tools SET access = ?, access_src = ?, ns = ? WHERE id = ?").run(decided ?? "write", src, ns, row.id);
          else this.db.prepare("UPDATE tools SET ns = ? WHERE id = ?").run(ns, row.id);
          continue;
        }
        const access = decided ?? "write";
        changed.push(t.name);
        const vals = [ident, ns, summaryOf(t.description), t.description ?? "", toolDecl(ident, t), toolDecl(ident, t, "any"), access, src, hash];
        let id = row?.id;
        if (row) this.db.prepare("UPDATE tools SET ident=?, ns=?, summary=?, description=?, decl=?, check_decl=?, access=?, access_src=?, hash=? WHERE id=?").run(...vals, id);
        else id = this.db.prepare("INSERT INTO tools(ident, ns, summary, description, decl, check_decl, access, access_src, hash, server, name) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(...vals, server, t.name).lastInsertRowid;
        this.db.prepare("DELETE FROM tools_fts WHERE rowid = ?").run(id);
        this.db.prepare("INSERT INTO tools_fts(rowid, ident, summary, description) VALUES (?,?,?,?)").run(id, `${ns}.${ident}`, summaryOf(t.description), t.description ?? "");
      }
      for (const [name, r] of existing) {
        if (seen.has(name)) continue;
        this.db.prepare("DELETE FROM tools WHERE id = ?").run(r.id);
        this.db.prepare("DELETE FROM tools_fts WHERE rowid = ?").run(r.id);
      }
      this.db.prepare("INSERT INTO servers(name, ns, status, updated) VALUES (?,?,'up',?) ON CONFLICT(name) DO UPDATE SET ns = excluded.ns").run(server, ns, Date.now());
    });
    return { changed, errors };
  }

  // Tools with no override, annotation or model verdict (currently treated as write).
  unclassified(): { server: string; name: string; decl: string }[] {
    return this.db.prepare("SELECT server, name, decl FROM tools WHERE access_src = 'default' ORDER BY server, name").all() as any;
  }

  setModelAccess(server: string, name: string, access: "read" | "write"): void {
    this.db.prepare("UPDATE tools SET access = ?, access_src = 'model' WHERE server = ? AND name = ? AND access_src IN ('default', 'model')").run(access, server, name);
  }

  removeServer(server: string): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM tools_fts WHERE rowid IN (SELECT id FROM tools WHERE server = ?)").run(server);
      this.db.prepare("DELETE FROM tools WHERE server = ?").run(server);
      this.db.prepare("DELETE FROM servers WHERE name = ?").run(server);
    });
  }

  // Search-format lines for used tools and recipes, most used first.
  topByUsage(n: number): string[] {
    return this.db.prepare(`
      SELECT line FROM (
        SELECT ns || '.' || ident || ' — ' || summary || ' [' || access || ']' AS line, usage FROM tools WHERE usage > 0
        UNION ALL SELECT 'recipes.' || name || ' — ' || description || ' [recipe]', usage FROM recipes WHERE status = 'ok' AND usage > 0
      ) ORDER BY usage DESC LIMIT ?`).all(n).map((r) => r.line as string);
  }

  pruneCalls(maxAgeMs: number): number {
    return Number(this.db.prepare("DELETE FROM calls WHERE ts < ?").run(Date.now() - maxAgeMs).changes);
  }

  checkNamespace(server: string, ns: string): string | null {
    const r = this.db.prepare("SELECT name FROM servers WHERE ns = ? AND name != ?").get(ns, server);
    return r ? `namespace "${ns}" is used by both "${r.name}" and "${server}"; set "alias" on one of them in servers.json` : null;
  }

  markServer(server: string, status: ServerStatus, reason?: string): void {
    this.db.prepare("INSERT INTO servers(name, status, reason, updated) VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET status = excluded.status, reason = excluded.reason, updated = excluded.updated")
      .run(server, status, reason ?? null, Date.now());
  }

  servers(): { name: string; ns: string | null; status: string; reason: string | null }[] {
    return this.db.prepare("SELECT name, ns, status, reason FROM servers ORDER BY name").all() as any;
  }

  search(query: string, limit = 10): string[] {
    const q = ftsQuery(query);
    const rows = q
      ? this.db.prepare(`
        SELECT line FROM (
          SELECT t.ns || '.' || t.ident || ' — ' || t.summary || ' [' || t.access || ']' AS line,
                 bm25(tools_fts, 10.0, 5.0, 1.0) - 2.0 * ln(1 + t.usage) AS rank
            FROM tools_fts JOIN tools t ON t.id = tools_fts.rowid WHERE tools_fts MATCH ?
          UNION ALL
          SELECT 'recipes.' || r.name || ' — ' || r.description || ' [recipe]', bm25(recipes_fts, 10.0, 1.0) - 2.0 * ln(1 + r.usage)
            FROM recipes_fts JOIN recipes r ON r.id = recipes_fts.rowid WHERE recipes_fts MATCH ? AND r.status = 'ok'
        ) ORDER BY rank LIMIT ?`).all(q, q, limit)
      : this.db.prepare(`
        SELECT line FROM (
          SELECT ns || '.' || ident || ' — ' || summary || ' [' || access || ']' AS line, usage FROM tools
          UNION ALL SELECT 'recipes.' || name || ' — ' || description || ' [recipe]', usage FROM recipes WHERE status = 'ok'
        ) ORDER BY usage DESC, line LIMIT ?`).all(limit);
    return rows.map((r) => r.line as string);
  }

  describe(names: string[]): string {
    const groups = new Map<string, string[]>();
    const missing: string[] = [];
    for (const n of names) {
      const i = n.indexOf(".");
      const [ns, id] = i < 0 ? ["", n] : [n.slice(0, i), n.slice(i + 1)];
      let decl: string | undefined;
      if (ns === "recipes") {
        const r = this.db.prepare("SELECT description FROM recipes WHERE name = ? AND status = 'ok'").get(id);
        if (r) decl = `/** ${r.description} */\n${id}(args: any): Promise<unknown>;`;
      } else {
        decl = this.db.prepare("SELECT decl FROM tools WHERE ns = ? AND ident = ?").get(ns, id)?.decl as string | undefined;
      }
      if (!decl) { missing.push(n); continue; }
      groups.set(ns, [...(groups.get(ns) ?? []), decl]);
    }
    const out = [...groups].map(([ns, ds]) => `// ${ns}\n${ds.join("\n")}`);
    for (const m of missing) out.push(`// not found: ${m}`);
    return out.join("\n");
  }

  resolve(ns: string, ident: string): { server: string; tool: string; access: Access } | undefined {
    const r = this.db.prepare("SELECT server, name, access FROM tools WHERE ns = ? AND ident = ?").get(ns, ident);
    return r ? { server: r.server as string, tool: r.name as string, access: r.access as Access } : undefined;
  }

  allTools(): { ns: string; ident: string; server: string; name: string; access: Access }[] {
    return this.db.prepare("SELECT ns, ident, server, name, access FROM tools ORDER BY ns, ident").all() as any;
  }

  namespaces(): Set<string> {
    return new Set(this.db.prepare("SELECT DISTINCT ns FROM tools").all().map((r) => r.ns as string));
  }

  checkDeclarations(): string {
    const byNs = new Map<string, string[]>();
    for (const r of this.db.prepare("SELECT ns, check_decl FROM tools ORDER BY ns, ident").all()) {
      byNs.set(r.ns as string, [...(byNs.get(r.ns as string) ?? []), r.check_decl as string]);
    }
    return [...byNs].map(([ns, ds]) => `declare const ${ns}: {\n${ds.join("\n")}\n};`).join("\n");
  }

  logCall(c: { server: string; tool: string; ms: number; bytes: number; runId: string }): void {
    this.db.prepare("INSERT INTO calls(ts, server, tool, ms, bytes, run_id) VALUES (?,?,?,?,?,?)").run(Date.now(), c.server, c.tool, c.ms, c.bytes, c.runId);
  }

  // usage = Σ exp(-age_days / 7) over logged calls.
  recomputeUsage(now = Date.now()): void {
    this.tx(() => {
      this.db.prepare(`UPDATE tools SET usage = COALESCE((SELECT SUM(exp(-(? - c.ts) / 86400000.0 / 7)) FROM calls c WHERE c.server = tools.server AND c.tool = tools.name), 0)`).run(now);
      this.db.prepare(`UPDATE recipes SET usage = COALESCE((SELECT SUM(exp(-(? - c.ts) / 86400000.0 / 7)) FROM calls c WHERE c.server = 'recipes' AND c.tool = recipes.name), 0)`).run(now);
    });
  }

  recordKeySizes(server: string, tool: string, sizes: Record<string, number>): void {
    const st = this.db.prepare("INSERT INTO key_sizes(server, tool, key, total, n) VALUES (?,?,?,?,1) ON CONFLICT DO UPDATE SET total = total + excluded.total, n = n + 1");
    for (const [k, v] of Object.entries(sizes)) st.run(server, tool, k, v);
  }

  proposeRules(minAvg = 2000, minN = 5): number {
    return Number(this.db.prepare("INSERT OR IGNORE INTO rules(server, tool, key, status) SELECT server, tool, key, 'proposed' FROM key_sizes WHERE n >= ? AND total * 1.0 / n >= ?").run(minN, minAvg).changes);
  }
  rules(status?: string): Rule[] {
    return (status ? this.db.prepare("SELECT * FROM rules WHERE status = ? ORDER BY id").all(status) : this.db.prepare("SELECT * FROM rules ORDER BY id").all()) as any;
  }
  setRule(id: number, status: "proposed" | "accepted" | "rejected"): void {
    if (!this.db.prepare("UPDATE rules SET status = ? WHERE id = ?").run(status, id).changes) throw new Error(`no rule ${id}`);
  }
  dropKeys(server: string, tool: string): string[] {
    return this.db.prepare("SELECT key FROM rules WHERE server = ? AND tool = ? AND status = 'accepted'").all(server, tool).map((r) => r.key as string);
  }

  upsertRecipe(name: string, description: string, status = "ok", reason?: string): void {
    this.tx(() => {
      const id = this.db.prepare("INSERT INTO recipes(name, description, status, reason) VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET description = excluded.description, status = excluded.status, reason = excluded.reason RETURNING id")
        .get(name, description, status, reason ?? null)!.id;
      this.db.prepare("DELETE FROM recipes_fts WHERE rowid = ?").run(id);
      this.db.prepare("INSERT INTO recipes_fts(rowid, name, description) VALUES (?,?,?)").run(id, name, description);
    });
  }
  recipes(): { name: string; description: string; status: string; reason: string | null }[] {
    return this.db.prepare("SELECT name, description, status, reason FROM recipes ORDER BY name").all() as any;
  }

  get(k: string): string | undefined { return this.db.prepare("SELECT v FROM meta WHERE k = ?").get(k)?.v as string | undefined; }
  set(k: string, v: string): void { this.db.prepare("INSERT INTO meta(k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v); }
}
