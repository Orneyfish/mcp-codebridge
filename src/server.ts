import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Catalog } from "./catalog/catalog.ts";
import { buildInstructions } from "./instructions.ts";
import type { Runs } from "./runs.ts";

type Deps = { runs: Runs; catalog: Catalog; saveRecipe: (name: string, code: string, description: string) => string };

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
    description: "Find upstream MCP tools and saved recipes by keywords. Returns one line each: ns.tool — summary [read|write|recipe].",
    inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).optional() },
  }, ({ query, limit }) => guard(() => catalog.search(query, limit).join("\n") || "no matches")());

  server.registerTool("describe", {
    description: "TypeScript signatures for the named tools/recipes (e.g. [\"vercel.list_deployments\"]).",
    inputSchema: { names: z.array(z.string()).min(1) },
  }, ({ names }) => guard(() => catalog.describe(names))());

  server.registerTool("execute", {
    description: "Run an async JS/TS function body in a sandbox. Call tools as await ns.tool({...}); return only what's needed. Returns {status: completed|paused|error, ...}.",
    inputSchema: { code: z.string(), timeout_ms: z.number().int().positive().optional() },
  }, ({ code, timeout_ms }) => guard(async () => JSON.stringify(await runs.execute(code, timeout_ms)))());

  server.registerTool("approve", {
    description: "Answer a paused write: decision \"yes\" runs it, \"no\" makes it throw ApprovalDenied. Only after the user agrees.",
    inputSchema: { run_id: z.string(), decision: z.enum(["yes", "no"]) },
  }, ({ run_id, decision }) => guard(async () => JSON.stringify(await runs.approve(run_id, decision)))());

  server.registerTool("save_recipe", {
    description: "Save a working execute body as recipes.<name>(args); args is available inside the code.",
    inputSchema: { name: z.string(), code: z.string(), description: z.string() },
  }, ({ name, code, description }) => guard(() => saveRecipe(name, code, description))());

  return server;
}
