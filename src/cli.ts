#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Catalog } from "./catalog/catalog.ts";
import { loadServers, type ServerEntry } from "./config.ts";
import { recipePrelude, saveRecipe } from "./recipes.ts";
import { refresh } from "./refresh.ts";
import { Runs } from "./runs.ts";
import { DenoExecutor } from "./sandbox/deno.ts";
import { createServer } from "./server.ts";
import { Stash } from "./stash.ts";
import { Upstreams } from "./upstream/manager.ts";
import { FileOAuthProvider } from "./upstream/oauth.ts";

export function makeUpstreams(servers: Record<string, ServerEntry>): Upstreams {
  const enabled = Object.fromEntries(Object.entries(servers).filter(([, e]) => !e.disabled));
  return new Upstreams(enabled, (name, e) => new FileOAuthProvider(name, { interactive: false, clientId: e.oauth?.clientId }));
}

async function serve() {
  const catalog = new Catalog();
  const upstreams = makeUpstreams(loadServers());
  const stash = new Stash();
  const runs = new Runs({ executor: new DenoExecutor(), catalog, upstreams, stash, recipePrelude: (code) => recipePrelude(code, catalog) });
  const server = createServer({ runs, catalog, saveRecipe: (n, c, d) => saveRecipe(n, c, d, catalog) });
  const shutdown = async () => { runs.close(); await upstreams.close(); process.exit(0); };
  process.stdin.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  await server.connect(new StdioServerTransport());
}

async function refreshCmd() {
  const servers = loadServers();
  const upstreams = makeUpstreams(servers);
  try {
    const r = await refresh({ servers, catalog: new Catalog(), upstreams, stash: new Stash() });
    const list = (k: string, v: string[]) => console.log(`${k}: ${v.length ? v.join(", ") : "-"}`);
    list("up", r.up); list("stale", r.stale); list("unsupported", r.unsupported); list("failed", r.failed);
    console.log(`changed tools: ${r.changed.length}, model-classified: ${r.classified}, new rule proposals: ${r.proposed}`);
    list("broken recipes", r.broken);
    for (const e of r.errors) console.log(`error: ${e}`);
  } finally {
    await upstreams.close();
  }
}

function rulesCmd(sub = "list", id?: string) {
  const catalog = new Catalog();
  if (sub === "list") {
    for (const r of catalog.rules()) console.log(`${r.id}\t${r.server}.${r.tool}\tdrop "${r.key}"\t${r.status}`);
    return;
  }
  if ((sub !== "accept" && sub !== "reject") || !id) throw new Error("usage: codebridge rules [list | accept <id> | reject <id>]");
  catalog.setRule(Number(id), sub === "accept" ? "accepted" : "rejected");
  console.log(`rule ${id} ${sub}ed`);
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (!cmd || cmd === "serve") await serve();
  else if (cmd === "refresh") await refreshCmd();
  else if (cmd === "rules") rulesCmd(rest[0], rest[1]);
  else throw new Error(`unknown command: ${cmd}\nusage: codebridge [serve | refresh | rules | import | login <server> | verify <server> | status]`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
