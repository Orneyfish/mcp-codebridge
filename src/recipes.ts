import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Catalog } from "./catalog/catalog.ts";
import { paths } from "./paths.ts";

// File format: line 1 is "/** @description <text> */", the rest is the function body (receives `args`).
const file = (name: string) => join(paths().recipesDir, `${name}.ts`);
const body = (name: string) => readFileSync(file(name), "utf8").split("\n").slice(1).join("\n");
const recipeRefs = (code: string) => [...code.matchAll(/(?<![.\w$])recipes\.([a-z][a-z0-9_]*)/g)].map((m) => m[1]);

export function recipeCalls(code: string, namespaces: Set<string>): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/(?<![.\w$])([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s*\(/g)) {
    if (namespaces.has(m[1]) && !out.includes(`${m[1]}.${m[2]}`)) out.push(`${m[1]}.${m[2]}`);
  }
  return out;
}

const missingTools = (code: string, catalog: Catalog) =>
  recipeCalls(code, catalog.namespaces()).filter((c) => { const [ns, id] = c.split("."); return !catalog.resolve(ns, id); });

export function saveRecipe(name: string, code: string, description: string, catalog: Catalog): string {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new Error(`invalid recipe name "${name}": use lowercase letters, digits, _ (max 64)`);
  const missing = missingTools(code, catalog);
  if (missing.length) throw new Error(`unknown tools: ${missing.join(", ")}`);
  const desc = description.replace(/\s+/g, " ").replace(/\*\//g, "* /").trim();
  mkdirSync(paths().recipesDir, { recursive: true, mode: 0o700 });
  writeFileSync(file(name), `/** @description ${desc} */\n${code}\n`);
  catalog.upsertRecipe(name, desc, "ok");
  return `saved recipes.${name}`;
}

// Inlines the ok recipes the code references (transitively) and logs their use for ranking.
export function recipePrelude(code: string, catalog: Catalog): string {
  const ok = new Set(catalog.recipes().filter((r) => r.status === "ok").map((r) => r.name));
  const used = new Map<string, string>();
  const queue = recipeRefs(code);
  while (queue.length) {
    const n = queue.shift()!;
    if (used.has(n) || !ok.has(n) || !existsSync(file(n))) continue;
    const b = body(n);
    used.set(n, b);
    queue.push(...recipeRefs(b));
  }
  for (const n of used.keys()) catalog.logCall({ server: "recipes", tool: n, ms: 0, bytes: 0, runId: "" });
  return `const recipes = {${[...used].map(([n, b]) => `\n${n}: async (args) => {\n${b}\n},`).join("")}\n};`;
}

export function checkRecipes(catalog: Catalog): { name: string; reason: string }[] {
  const broken: { name: string; reason: string }[] = [];
  const decls = catalog.checkDeclarations() +
    "\ndeclare const recipes: Record<string, (args: any) => Promise<any>>;\ndeclare const stash: { get(id: string): Promise<any> };\n";
  for (const r of catalog.recipes()) {
    let reason = "";
    if (!existsSync(file(r.name))) reason = "recipe file missing";
    else {
      const b = body(r.name);
      const missing = missingTools(b, catalog);
      if (missing.length) reason = `missing ${missing.join(", ")}`;
      else {
        const dir = mkdtempSync(join(tmpdir(), "cb-check-"));
        writeFileSync(join(dir, "check.ts"), `${decls}async function __r(args: any) {\n${b}\n}\nexport {};\n`);
        const p = spawnSync("deno", ["check", "--no-config", "--no-remote", "check.ts"], { cwd: dir, env: { ...process.env, NO_COLOR: "1" }, encoding: "utf8" });
        rmSync(dir, { recursive: true, force: true });
        if (p.status !== 0) reason = (p.stderr || p.stdout || "deno check failed").trim().slice(0, 300);
      }
    }
    catalog.upsertRecipe(r.name, r.description, reason ? "broken" : "ok", reason || undefined);
    if (reason) broken.push({ name: r.name, reason });
  }
  return broken;
}
