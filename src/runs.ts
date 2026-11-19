import { randomBytes } from "node:crypto";
import type { Catalog } from "./catalog/catalog.ts";
import type { Executor, Fns } from "./executor.ts";
import { appendAudit } from "./gate/audit.ts";
import { cap, keySizes, toScriptValue, trim } from "./shape.ts";
import type { Stash } from "./stash.ts";
import type { Upstreams } from "./upstream/manager.ts";

export type Outcome =
  | { status: "completed"; result: unknown; logs: string[]; stashed?: string }
  | { status: "error"; error: string; logs: string[] }
  | { status: "paused"; run_id: string; pending: { server: string; tool: string; args: unknown } };

type ToolRef = { ns: string; ident: string; server: string; name: string; access: "read" | "write" };
type Run = {
  id: string;
  clock: { paused: boolean };
  ac: AbortController;
  done: Promise<Outcome>;
  waiter?: (o: Outcome) => void;
  pending?: { server: string; tool: string; args: unknown; decide: (yes: boolean) => void };
  expiry?: NodeJS.Timeout;
  writes: Promise<void>;
};

type Deps = {
  executor: Executor; catalog: Catalog; upstreams: Upstreams; stash: Stash;
  elicit?: (msg: string) => Promise<boolean>;
  recipePrelude?: (code: string) => string;
  pauseTtlMs?: number;
};

export class Runs {
  elicit?: (msg: string) => Promise<boolean>; // set by createServer once the client's capabilities are known
  private d: Deps;
  private runs = new Map<string, Run>();
  constructor(d: Deps) { this.d = d; this.elicit = d.elicit; }

  execute(code: string, timeoutMs?: number): Promise<Outcome> {
    const run: Run = { id: randomBytes(6).toString("hex"), clock: { paused: false }, ac: new AbortController(), done: undefined as any, writes: Promise.resolve() };
    const fns: Fns = { "stash.get": async (id) => this.d.stash.get(String(id)) };
    for (const t of this.d.catalog.allTools()) {
      fns[`${t.ns}.${t.ident}`] = (args) => (t.access === "read" ? this.call(run, t, args) : this.write(run, t, args));
    }
    this.runs.set(run.id, run);
    run.done = this.d.executor
      .execute(code, fns, { timeoutMs, clock: run.clock, signal: run.ac.signal, prelude: this.d.recipePrelude?.(code) })
      .then((r): Outcome => r.error !== undefined
        ? { status: "error", error: r.error, logs: r.logs ?? [] }
        : (({ value, stashed }) => ({ status: "completed" as const, result: value, logs: r.logs ?? [], ...(stashed ? { stashed } : {}) }))(cap(r.result, this.d.stash)))
      .finally(() => { clearTimeout(run.expiry); this.runs.delete(run.id); });
    return this.wait(run);
  }

  approve(runId: string, decision: "yes" | "no"): Promise<Outcome> {
    const run = this.runs.get(runId);
    const p = run?.pending;
    if (!run || !p) return Promise.reject(new Error(`unknown or expired run ${runId}`));
    run.pending = undefined;
    clearTimeout(run.expiry);
    run.clock.paused = false;
    const out = this.wait(run);
    p.decide(decision === "yes");
    return out;
  }

  // Abort every live run (paused ones included); used on shutdown.
  close(): void {
    for (const run of this.runs.values()) { clearTimeout(run.expiry); run.ac.abort(); }
  }

  private wait(run: Run): Promise<Outcome> {
    return new Promise((res) => { run.waiter = res; run.done.then(res); });
  }

  private async call(run: Run, t: ToolRef, args: unknown): Promise<unknown> {
    const t0 = Date.now();
    let bytes = 0;
    try {
      const r = await this.d.upstreams.callTool(t.server, t.name, args);
      bytes = JSON.stringify(r).length;
      const v = toScriptValue(r, this.d.stash);
      this.d.catalog.recordKeySizes(t.server, t.name, keySizes(v));
      const out = trim(v, this.d.catalog.dropKeys(t.server, t.name), this.d.stash);
      this.d.catalog.learnShape(t.server, t.name, out);
      return out;
    } finally {
      this.d.catalog.logCall({ server: t.server, tool: t.name, ms: Date.now() - t0, bytes, runId: run.id });
    }
  }

  // Writes are serialised per run; each waits for elicitation or approve().
  private async write(run: Run, t: ToolRef, args: unknown): Promise<unknown> {
    const prev = run.writes;
    let release!: () => void;
    run.writes = new Promise((r) => { release = r; });
    await prev;
    try {
      const audit = (decision: "approved" | "denied", via: "elicitation" | "approve" | "expired") =>
        appendAudit({ run_id: run.id, server: t.server, tool: t.name, args, decision, via });
      let yes: boolean | undefined;
      if (this.elicit) {
        run.clock.paused = true;
        try {
          yes = await this.elicit(`codebridge wants to run a write: ${t.ns}.${t.ident} (server "${t.server}", tool "${t.name}")\nArguments: ${JSON.stringify(args ?? null).slice(0, 1000)}`);
          audit(yes ? "approved" : "denied", "elicitation");
        } catch { yes = undefined; }
        run.clock.paused = false;
      }
      if (yes === undefined) {
        yes = await new Promise<boolean>((decide) => {
          run.pending = { server: t.server, tool: t.name, args, decide };
          run.clock.paused = true;
          run.expiry = setTimeout(() => {
            run.pending = undefined;
            audit("denied", "expired");
            run.ac.abort();
          }, this.d.pauseTtlMs ?? 900_000);
          run.waiter?.({ status: "paused", run_id: run.id, pending: { server: t.server, tool: t.name, args } });
        });
        audit(yes ? "approved" : "denied", "approve");
      }
      if (!yes) throw new Error(`ApprovalDenied: ${t.ns}.${t.ident} denied by user`);
      return await this.call(run, t, args);
    } finally {
      release();
    }
  }
}
