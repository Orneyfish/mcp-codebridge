#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Catalog } from "./catalog/catalog.ts";
import { loadServers, type ServerEntry } from "./config.ts";
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
  const runs = new Runs({ executor: new DenoExecutor(), catalog, upstreams, stash });
  const server = createServer({ runs, catalog, saveRecipe: () => { throw new Error("recipes not available yet"); } });
  const shutdown = async () => { runs.close(); await upstreams.close(); process.exit(0); };
  process.stdin.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  await server.connect(new StdioServerTransport());
}

const [cmd] = process.argv.slice(2);
if (!cmd || cmd === "serve") await serve();
else { console.error(`unknown command: ${cmd}`); process.exit(2); }
