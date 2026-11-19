// Test MCP server. stdio by default; `--http 0` / `--sse 0` listen on a free port and print "listening <port>".
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

let lastAuth = false;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const log = (name: string) => { if (process.env.FIXTURE_LOG) appendFileSync(process.env.FIXTURE_LOG, name + "\n"); };
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function build() {
  const s = new McpServer({ name: "fixture", version: "1.0.0" });
  s.registerTool("get_item", { description: "Get one item by id. Returns its name.", inputSchema: { id: z.string().describe("Item id") }, annotations: { readOnlyHint: true } },
    async ({ id }) => { log("get_item"); return text(JSON.stringify({ id, name: "item " + id, empty: null, tags: [], auth: lastAuth })); });
  s.registerTool("list_items", { description: "List all items.", inputSchema: {}, outputSchema: { items: z.array(z.object({ id: z.string(), blob: z.string() })) } },
    async () => { log("list_items"); const sc = { items: [1, 2, 3, 4, 5].map((i) => ({ id: String(i), blob: "x".repeat(3000) })) }; return { ...text(JSON.stringify(sc)), structuredContent: sc }; });
  s.registerTool("delete_item", { description: "Delete an item.", inputSchema: { id: z.string() }, annotations: { destructiveHint: true } },
    async ({ id }) => { log("delete_item"); return text("deleted " + id); });
  s.registerTool("make_thing", { description: "Make a thing.", inputSchema: {} }, async () => { log("make_thing"); return text("made"); });
  s.registerTool("image_tool", { description: "Return an image.", inputSchema: {} },
    async () => { log("image_tool"); return { content: [{ type: "image" as const, data: PNG, mimeType: "image/png" }] }; });
  s.registerTool("fail_tool", { description: "Always fails.", inputSchema: {} }, async () => { log("fail_tool"); return { ...text("nope"), isError: true }; });
  s.registerTool("crash", { description: "Exit the process.", inputSchema: {} }, async () => { log("crash"); process.exit(1); });
  s.registerTool("slow", { description: "Sleep.", inputSchema: { ms: z.number() } },
    async ({ ms }) => { log("slow"); await new Promise((r) => setTimeout(r, ms)); return text("slept"); });
  s.registerTool("echo_env", { description: "Echo FIXTURE_SECRET.", inputSchema: {} }, async () => { log("echo_env"); return text(process.env.FIXTURE_SECRET ?? "unset"); });
  return s;
}

const mode = process.argv[2];
if (!mode) {
  await build().connect(new StdioServerTransport());
} else {
  const sse = new Map<string, SSEServerTransport>();
  const http = createServer(async (req, res) => {
    lastAuth = !!req.headers.authorization;
    if (mode === "--http") {
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await build().connect(t);
      await t.handleRequest(req, res);
    } else if (req.method === "GET") {
      const t = new SSEServerTransport("/messages", res);
      sse.set(t.sessionId, t);
      await build().connect(t);
    } else {
      const id = new URL(req.url!, "http://x").searchParams.get("sessionId")!;
      await sse.get(id)!.handlePostMessage(req, res);
    }
  });
  http.listen(Number(process.argv[3] ?? 0), "127.0.0.1", () => console.log("listening " + (http.address() as any).port));
}
