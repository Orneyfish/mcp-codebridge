import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Catalog } from "./catalog/catalog.ts";
import { buildInstructions } from "./instructions.ts";
import type { Runs } from "./runs.ts";

type Deps = { runs: Runs; catalog: Catalog; saveRecipe: (name: string, code: string, description: string) => string };

// Keep the five tools out of Claude Code's tool-search deferral (design G2: always loaded, < ~1k tokens).
const _meta = { "anthropic/alwaysLoad": true };
const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError } : {}) });
const guard = (f: () => Promise<string> | string) => async () => {
  try { return text(await f()); } catch (e) { return text(e instanceof Error ? e.message : String(e), true); }
};

export function createServer({ runs, catalog, saveRecipe }: Deps): McpServer {
  const top = (catalog.get("instructions_top") ?? "").split("\n").filter(Boolean);
  const server = new McpServer({ name: "codebridge", version: "0.1.0" }, { instructions: buildInstructions(top) });

  server.server.oninitialized = () => {
    if (!server.server.getClientCapabilities()?.elicitation) return;
    runs.elicit = async (message) => {
      const r = await server.server.elicitInput({ message, requestedSchema: { type: "object", properties: {} } });
      return r.action === "accept";
    };
  };

  server.registerTool("search", {
    _meta,
    description: "Find upstream MCP tools and saved recipes by keywords: one line each (ns.tool — summary [read|write|recipe]), plus TypeScript signatures of the top 3.",
    inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).optional() },
  }, ({ query, limit }) => guard(() => {
    const lines = catalog.search(query, limit);
    if (!lines.length) return "no matches";
    // Signatures of the top 3 save a describe round trip in the common case.
    return `${lines.join("\n")}\n\n${catalog.describe(lines.slice(0, 3).map((l) => l.split(" — ")[0]))}`;
  })());

  server.registerTool("describe", {
    _meta,
    description: "TypeScript signatures for the named tools/recipes (e.g. [\"vercel.list_deployments\"]).",
    inputSchema: { names: z.array(z.string()).min(1) },
  }, ({ names }) => guard(() => catalog.describe(names))());

  server.registerTool("execute", {
    _meta,
    description: "Run an async JS/TS function body in a sandbox. Call tools as await ns.tool({...}); return only what's needed. Returns {status: completed|paused|error, ...}.",
    inputSchema: { code: z.string(), timeout_ms: z.number().int().positive().optional() },
  }, ({ code, timeout_ms }) => guard(async () => JSON.stringify(await runs.execute(code, timeout_ms)))());

  server.registerTool("approve", {
    _meta,
    description: "Answer a paused write: decision \"yes\" runs it, \"no\" makes it throw ApprovalDenied. Only after the user agrees.",
    inputSchema: { run_id: z.string(), decision: z.enum(["yes", "no"]) },
  }, ({ run_id, decision }) => guard(async () => JSON.stringify(await runs.approve(run_id, decision)))());

  server.registerTool("save_recipe", {
    _meta,
    description: "Save a working execute body as recipes.<name>(args); args is available inside the code.",
    inputSchema: { name: z.string(), code: z.string(), description: z.string() },
  }, ({ name, code, description }) => guard(() => saveRecipe(name, code, description))());

  return server;
}
