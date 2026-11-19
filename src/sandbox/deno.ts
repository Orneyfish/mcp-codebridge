import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecuteOptions, ExecuteResult, Executor, Fns } from "../executor.ts";
import { PRELUDE } from "./prelude.ts";

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 300_000;
export const STDOUT_CAP = 10 * 1024 * 1024;
export const MAX_CALLS = 200;

const FLAGS = [
  "run", "--no-prompt", "--no-config", "--no-remote", "--no-npm",
  "--deny-net", "--deny-read", "--deny-write", "--deny-env", "--deny-run", "--deny-ffi", "--deny-sys",
  "--v8-flags=--max-old-space-size=256",
];

export class DenoExecutor implements Executor {
  execute(code: string, fns: Fns, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
    const timeoutMs = Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const dir = mkdtempSync(join(tmpdir(), "cb-run-"));
    const namespaces = new Set<string>();
    for (const k of Object.keys(fns)) if (k.includes(".")) namespaces.add(k.slice(0, k.indexOf(".")));
    const decls = [...namespaces].map((ns) => `const ${ns} = __namespace(${JSON.stringify(ns)});`).join("\n");
    writeFileSync(join(dir, "run.ts"),
      `${PRELUDE}\n${decls}\n${opts.prelude ?? ""}\nasync function __main() {\n${code}\n}\n__run(__main);\n`);

    const child = spawn("deno", [...FLAGS, "run.ts"], {
      cwd: dir,
      env: { PATH: process.env.PATH, NO_COLOR: "1", DENO_NO_UPDATE_CHECK: "1", DENO_DIR: join(dir, ".deno") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", () => {});

    return new Promise((resolve) => {
      const logs: string[] = [];
      let settled = false, outBytes = 0, calls = 0, stderr = "", buf = "";
      let elapsed = 0, last = Date.now();

      const finish = (r: { result?: unknown; error?: string }) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        child.kill("SIGKILL");
        rmSync(dir, { recursive: true, force: true });
        resolve(r.error === undefined ? { result: r.result, logs } : { result: null, error: r.error, logs });
      };
      const onAbort = () => finish({ error: "aborted" });
      opts.signal?.addEventListener("abort", onAbort);
      if (opts.signal?.aborted) onAbort();

      const timer = setInterval(() => {
        const now = Date.now();
        if (!opts.clock?.paused) elapsed += now - last;
        last = now;
        if (elapsed >= timeoutMs) finish({ error: `timeout after ${timeoutMs}ms` });
      }, 25);

      const reply = (m: object) => { if (!settled) child.stdin.write(JSON.stringify(m) + "\n"); };
      const onCall = async (m: { id: number; fn: string; args: unknown }) => {
        if (++calls > MAX_CALLS) return reply({ t: "ret", id: m.id, ok: false, error: `call limit (${MAX_CALLS}) reached` });
        const fn = fns[m.fn];
        if (!fn) return reply({ t: "ret", id: m.id, ok: false, error: `unknown tool ${m.fn}; use search/describe` });
        try {
          reply({ t: "ret", id: m.id, ok: true, value: (await fn(m.args)) ?? null });
        } catch (e) {
          reply({ t: "ret", id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      };
      const onLine = (line: string) => {
        let m: any;
        try { m = JSON.parse(line); } catch { m = undefined; }
        if (m?.t === "call") onCall(m);
        else if (m?.t === "log") logs.push(m.msg);
        else if (m?.t === "done") finish(m.ok ? { result: m.result } : { error: m.error });
        else if (line.length) logs.push(line);
      };

      child.stdout.on("data", (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > STDOUT_CAP) return finish({ error: "output cap exceeded (10 MiB)" });
        buf += chunk.toString("utf8");
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          onLine(line);
        }
      });
      child.stderr.on("data", (c: Buffer) => { stderr = (stderr + c.toString("utf8")).slice(-2000); });
      child.on("error", (e) => finish({ error: `sandbox failed to start: ${e.message}` }));
      child.on("close", () => finish({ error: "sandbox exited: " + stderr.trim() }));
    });
  }
}
