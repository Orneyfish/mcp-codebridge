import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { paths, writeSecretFile } from "./paths.ts";

const overrides = {
  alias: z.string().regex(/^[a-z_][a-z0-9_]*$/).optional(),
  disabled: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  tools: z.record(z.string(), z.object({ access: z.enum(["read", "write"]) })).optional(),
  oauth: z.object({ clientId: z.string().optional() }).optional(),
};
const Entry = z.union([
  z.looseObject({ type: z.literal("stdio").optional(), command: z.string(), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional(), ...overrides }),
  z.looseObject({ type: z.enum(["http", "sse"]), url: z.string().url(), headers: z.record(z.string(), z.string()).optional(), ...overrides }),
]);
export type ServerEntry = z.infer<typeof Entry>;

export function loadServers(file = paths().serversFile): Record<string, ServerEntry> {
  if (!existsSync(file)) return {};
  const raw = JSON.parse(readFileSync(file, "utf8")).mcpServers ?? {};
  const out: Record<string, ServerEntry> = {};
  for (const [name, e] of Object.entries(raw)) {
    const r = Entry.safeParse(e);
    if (!r.success) throw new Error(`servers.json: invalid entry "${name}": needs "command" (stdio) or "type" + "url" (http/sse)`);
    out[name] = r.data;
  }
  return out;
}

export function saveServers(servers: Record<string, ServerEntry>, file = paths().serversFile): void {
  writeSecretFile(file, JSON.stringify({ mcpServers: servers }, null, 2) + "\n");
}

export function resolveVars(rec: Record<string, string> | undefined, env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec ?? {})) {
    out[k] = v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
      const val = env[name];
      if (val === undefined) throw new Error(`environment variable ${name} (used by ${k}) is not set`);
      return val;
    });
  }
  return out;
}

export function toIdent(s: string): string {
  const id = s.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return /^[0-9]/.test(id) ? "_" + id : id;
}

export function namespaceOf(name: string, e: ServerEntry): string {
  return e.alias ?? toIdent(name);
}
