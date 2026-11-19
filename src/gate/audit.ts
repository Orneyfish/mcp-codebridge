import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "../paths.ts";

export function appendAudit(e: { run_id: string; server: string; tool: string; args: unknown; decision: "approved" | "denied"; via: "elicitation" | "approve" | "expired" }): void {
  const file = paths().auditLog;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  let args: string;
  try { args = JSON.stringify(e.args ?? null); } catch { args = String(e.args); }
  appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...e, args: args.slice(0, 500) }) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
}
