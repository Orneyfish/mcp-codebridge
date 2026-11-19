// Token benchmark (design §5.9): each task runs via `claude -p` with the direct servers only, then with codebridge only.
// Usage: node bench/run.ts [--tasks <file>] [--cold] [--with-recipes]
//   --cold: every bridge task starts from a fresh catalog copy (no learned shapes carried between tasks).
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type Event = Record<string, any>;
type Task = { id: string; prompt: string; servers: string[]; expect: string[] };
type Summary = { tokens: number; input: number; output: number; toolCalls: number; paused: boolean; answer: string };

export function summarize(events: Event[]): Summary {
  let toolCalls = 0, paused = false;
  for (const e of events) {
    for (const c of e.message?.content ?? []) {
      if (e.type === "assistant" && c.type === "tool_use") toolCalls++;
      if (c.type === "tool_result" && JSON.stringify(c.content).includes('\\"status\\":\\"paused\\"')) paused = true;
    }
  }
  const r = events.find((e) => e.type === "result");
  const u = r?.usage ?? {};
  const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const output = u.output_tokens ?? 0;
  return { tokens: input + output, input, output, toolCalls, paused, answer: r?.result ?? "" };
}

export function judge(s: Pick<Summary, "answer" | "paused">, expect: string[]): boolean {
  const a = s.answer.toLowerCase();
  return !s.paused && expect.every((x) => a.includes(x.toLowerCase()));
}

const ROOT = dirname(new URL(import.meta.url).pathname);
const OUT = join(ROOT, "out");
const BIN = join(homedir(), ".local/bin/codebridge");
const CB = join(homedir(), ".local/share/codebridge");

function claude(prompt: string, mcpConfig: string, allowed: string[]): Promise<{ events: Event[]; ms: number }> {
  const t0 = Date.now();
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--mcp-config", mcpConfig,
    "--tools", "ToolSearch", "--allowedTools", allowed.join(","), "--no-session-persistence"];
  const work = join(OUT, "work");
  mkdirSync(work, { recursive: true });
  return new Promise((resolve) => {
    const p = spawn("claude", args, { cwd: work, stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), 600_000);
    p.stdout.on("data", (d) => { buf += d; });
    p.on("close", () => {
      clearTimeout(timer);
      const events = buf.split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
      resolve({ events, ms: Date.now() - t0 });
    });
  });
}

const sh = (cmd: string, args: string[], env = process.env) => new Promise<number>((res) =>
  spawn(cmd, args, { stdio: "inherit", env }).on("close", (c) => res(c ?? 1)));

async function main() {
  const argv = process.argv;
  const withRecipes = argv.includes("--with-recipes");
  const cold = argv.includes("--cold");
  const tasksFile = argv.includes("--tasks") ? argv[argv.indexOf("--tasks") + 1] : join(ROOT, "tasks.json");
  const { primary, recipeTraining } = JSON.parse(readFileSync(tasksFile, "utf8")) as { primary: Task[]; recipeTraining: Task[] };
  console.log(`tasks: ${tasksFile} (${primary.length}), mode: ${cold ? "cold (fresh catalog per task)" : "warm (shapes accumulate within the run)"}`);
  const { loadServers } = await import("../src/config.ts");
  const { Catalog } = await import("../src/catalog/catalog.ts");
  const { openDb } = await import("../src/catalog/db.ts");
  const servers = loadServers();

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true, mode: 0o700 });
  try {
    // Isolated copy of the bridge's data dir (tokens included, 0600), refreshed, with no recipes.
    if ((await sh(BIN, ["refresh"])) !== 0) throw new Error("codebridge refresh failed");
    const data = join(OUT, "data");
    const seed = join(OUT, "seed");
    // Every run starts with no recipes and no learned shapes, whatever the live catalog has picked up.
    cpSync(CB, join(seed, "codebridge"), { recursive: true });
    rmSync(join(seed, "codebridge/recipes"), { recursive: true, force: true });
    const seedDb = openDb(join(seed, "codebridge/catalog.db"));
    seedDb.exec("DELETE FROM recipes; DELETE FROM recipes_fts; UPDATE tools SET learned = NULL; PRAGMA wal_checkpoint(TRUNCATE);");
    seedDb.close();
    const resetData = () => { rmSync(data, { recursive: true, force: true }); cpSync(seed, data, { recursive: true }); };
    resetData();
    const catalog = new Catalog(openDb(join(data, "codebridge/catalog.db")));

    const writeCfg = (name: string, cfg: object) => {
      const f = join(OUT, name);
      writeFileSync(f, JSON.stringify({ mcpServers: cfg }), { mode: 0o600 });
      return f;
    };
    const bridgeCfg = writeCfg("bridge.json", { codebridge: { command: BIN, env: { XDG_DATA_HOME: data } } });
    const bridgeAllowed = ["mcp__codebridge__search", "mcp__codebridge__describe", "mcp__codebridge__execute"];
    const directFor = (t: Task) => {
      const cfg = Object.fromEntries(t.servers.map((s) => [s, servers[s]]));
      const reads = catalog.allTools().filter((x) => t.servers.includes(x.server) && x.access === "read")
        .map((x) => `mcp__${x.server.replace(/[^A-Za-z0-9_-]/g, "_")}__${x.name}`);
      return { file: writeCfg(`direct-${t.id}.json`, cfg), allowed: reads };
    };

    const runSet = async (tasks: Task[], label: string, modes: ("direct" | "bridge")[]) => {
      const rows: any[] = [];
      for (const t of tasks) {
        for (const mode of modes) {
          if (cold && mode === "bridge" && label !== "training") resetData();
          const { file, allowed } = mode === "direct" ? directFor(t) : { file: bridgeCfg, allowed: bridgeAllowed };
          const { events, ms } = await claude(t.prompt, file, allowed);
          const s = summarize(events);
          rows.push({ set: label, task: t.id, mode, ok: judge(s, t.expect), tokens: s.tokens, input: s.input, output: s.output, toolCalls: s.toolCalls, ms, paused: s.paused, answer: s.answer.slice(0, 300) });
          console.log(`${label} ${t.id} ${mode}: ok=${rows.at(-1).ok} tokens=${s.tokens} tools=${s.toolCalls} ${ms}ms`);
        }
      }
      return rows;
    };
    const report = (rows: any[], label: string) => {
      const tot = (m: string) => rows.filter((r) => r.mode === m).reduce((a, r) => ({ tokens: a.tokens + r.tokens, ok: a.ok + (r.ok ? 1 : 0), tools: a.tools + r.toolCalls, ms: a.ms + r.ms }), { tokens: 0, ok: 0, tools: 0, ms: 0 });
      const d = tot("direct"), b = tot("bridge");
      console.log(`\n${label}\n| task | mode | ok | tokens | tool calls | ms |\n|---|---|---|---|---|---|`);
      for (const r of rows) console.log(`| ${r.task} | ${r.mode} | ${r.ok ? "yes" : "NO"} | ${r.tokens} | ${r.toolCalls} | ${r.ms} |`);
      if (!d.tokens) return;
      const saving = 1 - b.tokens / d.tokens;
      console.log(`direct: ${d.tokens} tokens, ${d.ok} ok, ${d.tools} calls | bridge: ${b.tokens} tokens, ${b.ok} ok, ${b.tools} calls`);
      console.log(`saving: ${(saving * 100).toFixed(1)}% → ${saving >= 0.3 && b.ok >= d.ok ? "PASS" : "FAIL"} (bar: ≥30% fewer tokens, equal success)`);
    };

    if (catalog.recipes().length !== 0) throw new Error("primary run requires zero recipes");
    const primaryRows = await runSet(primary, "primary", ["direct", "bridge"]);
    report(primaryRows, "Primary (no recipes)");
    let recipeRows: any[] = [];
    if (withRecipes) {
      bridgeAllowed.push("mcp__codebridge__save_recipe");
      await runSet(recipeTraining.map((t) => ({ ...t, prompt: t.prompt + " If a reusable script would help with similar questions later, save it with save_recipe." })), "training", ["bridge"]);
      bridgeAllowed.pop();
      console.log(`recipes saved during training: ${catalog.recipes().map((r) => r.name).join(", ") || "none"}`);
      recipeRows = await runSet(primary, "with-recipes", ["bridge"]);
      report([...primaryRows.filter((r) => r.mode === "direct"), ...recipeRows], "With recipes (reported separately)");
    }
    writeFileSync(join(ROOT, `results-${cold ? "cold-" : ""}${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.json`), JSON.stringify({ primary: primaryRows, withRecipes: recipeRows }, null, 1));
  } finally {
    rmSync(OUT, { recursive: true, force: true }); // copied tokens and configs
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
