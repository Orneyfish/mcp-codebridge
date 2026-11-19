import type { Catalog } from "./catalog/catalog.ts";
import { namespaceOf, type ServerEntry } from "./config.ts";
import { classifyWithModel, type Ask } from "./gate/model-classify.ts";
import { checkRecipes } from "./recipes.ts";
import type { Stash } from "./stash.ts";
import type { Upstreams } from "./upstream/manager.ts";

export type Report = {
  at: string; up: string[]; stale: string[]; unsupported: string[]; failed: string[];
  changed: string[]; errors: string[]; broken: string[]; classified: number; proposed: number;
};

export async function refresh(d: { servers: Record<string, ServerEntry>; catalog: Catalog; upstreams: Upstreams; stash: Stash; ask?: Ask }): Promise<Report> {
  const { catalog } = d;
  const r: Report = { at: new Date().toISOString(), up: [], stale: [], unsupported: [], failed: [], changed: [], errors: [], broken: [], classified: 0, proposed: 0 };
  const enabled = Object.entries(d.servers).filter(([, e]) => !e.disabled);
  const known = new Map(catalog.servers().map((s) => [s.name, s]));

  // 1. Catalog. Servers no longer configured (or disabled) drop out.
  for (const name of known.keys()) if (!enabled.some(([n]) => n === name)) catalog.removeServer(name);
  const byNs = new Map<string, string[]>();
  for (const [name, e] of enabled) byNs.set(namespaceOf(name, e), [...(byNs.get(namespaceOf(name, e)) ?? []), name]);
  for (const [name, e] of enabled) {
    const ns = namespaceOf(name, e);
    const clash = byNs.get(ns)!.length > 1
      ? `namespace "${ns}" is used by ${byNs.get(ns)!.map((n) => `"${n}"`).join(" and ")}; set "alias" on one of them in servers.json`
      : catalog.checkNamespace(name, ns);
    if (clash) { r.errors.push(clash); catalog.markServer(name, "failed", clash); r.failed.push(name); continue; }
    if (known.get(name)?.status === "unsupported") { r.unsupported.push(name); continue; }
    try {
      const res = catalog.syncServer(name, ns, await d.upstreams.listTools(name), e.tools);
      r.changed.push(...res.changed.map((t) => `${name}.${t}`));
      r.errors.push(...res.errors);
      catalog.markServer(name, "up");
      r.up.push(name);
    } catch (err) {
      catalog.markServer(name, "stale", err instanceof Error ? err.message : String(err));
      r.stale.push(name);
    }
  }

  // 2. Read/write verdicts for tools without override or annotation; failures leave them as write.
  const verdicts = await classifyWithModel(catalog.unclassified(), d.ask, r.errors);
  for (const [id, access] of verdicts) {
    const i = id.lastIndexOf("/");
    catalog.setModelAccess(id.slice(0, i), id.slice(i + 1), access);
  }
  r.classified = verdicts.size;

  // 3. Recipes. 4. Retention, then usage ranking. 5. Trim-rule proposals.
  r.broken = checkRecipes(catalog).map((b) => b.name);
  catalog.pruneCalls(30 * 86_400_000);
  d.stash.sweep();
  catalog.recomputeUsage();
  catalog.set("instructions_top", catalog.topByUsage(25).join("\n"));
  r.proposed = catalog.proposeRules();
  catalog.set("last_report", JSON.stringify(r));
  return r;
}
