import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { ErrorCode, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { resolveVars, type ServerEntry } from "../config.ts";

export type AuthProviderFactory = (server: string, entry: ServerEntry) => OAuthClientProvider | undefined;

/** True when the server itself answered with a JSON-RPC error; anything else (login, timeout, transport, crash, HTTP) means unreachable. */
export const serverAnswered = (err: unknown) =>
  err instanceof McpError && err.code !== ErrorCode.ConnectionClosed && err.code !== ErrorCode.RequestTimeout;

export class Upstreams {
  private servers: Record<string, ServerEntry>;
  private authProvider?: AuthProviderFactory;
  private onDown?: (server: string, reason: string) => void;
  private conns = new Map<string, Promise<Client>>();
  private crashes = new Map<string, number>();
  private closing = false;

  constructor(servers: Record<string, ServerEntry>, authProvider?: AuthProviderFactory, onDown?: (server: string, reason: string) => void) {
    this.servers = servers;
    this.authProvider = authProvider;
    this.onDown = onDown;
  }

  state(server: string): "idle" | "up" | "failed" {
    if ((this.crashes.get(server) ?? 0) >= 2) return "failed";
    return this.conns.has(server) ? "up" : "idle";
  }

  private client(server: string): Promise<Client> {
    const e = this.servers[server];
    if (!e) return Promise.reject(new Error(`${server}: unknown server`));
    if (this.state(server) === "failed") return Promise.reject(new Error(`${server}: failed (crashed twice); restart the bridge`));
    let p = this.conns.get(server);
    if (!p) {
      p = this.connect(server, e);
      this.conns.set(server, p);
      p.catch(() => this.conns.delete(server));
    }
    return p;
  }

  private async connect(server: string, e: ServerEntry): Promise<Client> {
    const client = new Client({ name: "codebridge", version: "0.1.0" });
    let transport;
    if ("command" in e) {
      transport = new StdioClientTransport({
        command: e.command, args: e.args ?? [],
        env: { ...getDefaultEnvironment(), ...resolveVars(e.env, process.env) },
        stderr: "ignore",
      });
    } else {
      const opts = { requestInit: { headers: resolveVars(e.headers, process.env) }, authProvider: this.authProvider?.(server, e) };
      transport = e.type === "sse" ? new SSEClientTransport(new URL(e.url), opts) : new StreamableHTTPClientTransport(new URL(e.url), opts);
    }
    let connected = false;
    client.onclose = () => {
      if (!connected || this.closing) return;
      this.conns.delete(server);
      this.crashes.set(server, (this.crashes.get(server) ?? 0) + 1);
    };
    await client.connect(transport);
    connected = true;
    return client;
  }

  private async wrap<T>(server: string, f: (c: Client) => Promise<T>): Promise<T> {
    try {
      return await f(await this.client(server));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!serverAnswered(err)) this.onDown?.(server, msg);
      throw new Error(msg.startsWith(`${server}: `) ? msg : `${server}: ${msg}`, { cause: err });
    }
  }

  listTools(server: string): Promise<Tool[]> {
    return this.wrap(server, async (c) => {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const r = await c.listTools(cursor ? { cursor } : undefined);
        tools.push(...r.tools);
        cursor = r.nextCursor;
      } while (cursor);
      return tools;
    });
  }

  callTool(server: string, tool: string, args: unknown): Promise<CallToolResult> {
    const timeout = this.servers[server]?.timeoutMs;
    return this.wrap(server, async (c) =>
      (await c.callTool({ name: tool, arguments: (args ?? {}) as Record<string, unknown> }, undefined, timeout ? { timeout } : undefined)) as CallToolResult);
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.conns.values()].map(async (p) => (await p).close()));
    this.conns.clear();
  }
}
