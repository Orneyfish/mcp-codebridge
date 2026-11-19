import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

export type Ask = (prompt: string) => Promise<string>;
type ToolMeta = { server: string; name: string; decl: string };

const PROMPT = `You classify MCP tools for a safety gate that asks the user before any write.
"read" = the tool only retrieves or computes information and has no side effects anywhere: nothing is created, updated, deleted, sent, posted, deployed, executed, triggered, purchased, approved, or logged in/out.
"write" = anything else, and anything you are unsure about.
Reply with only a JSON object mapping every tool id below to "read" or "write".

Tools:
`;

// Headless Haiku via the user's own Claude Code login; no MCP servers, no tools, no session saved.
export const askHaiku: Ask = (prompt) => new Promise((resolve, reject) => {
  const p = spawn("claude", ["-p", "--model", "haiku", "--strict-mcp-config", "--tools", "", "--no-session-persistence", "--output-format", "json"],
    { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("haiku: timed out after 180s")); }, 180_000);
  p.stdout.on("data", (d) => { out += d; });
  p.on("error", (e) => { clearTimeout(timer); reject(new Error(`haiku: ${e.message}`)); });
  p.on("close", () => {
    clearTimeout(timer);
    try {
      const j = JSON.parse(out);
      if (j.is_error || typeof j.result !== "string") throw new Error(j.terminal_reason ?? "no result");
      resolve(j.result);
    } catch (e) {
      reject(new Error(`haiku: ${e instanceof Error ? e.message : e}`));
    }
  });
  p.stdin.end(prompt);
});

export async function classifyWithModel(tools: ToolMeta[], ask: Ask = askHaiku, errors: string[] = []): Promise<Map<string, "read" | "write">> {
  const verdicts = new Map<string, "read" | "write">();
  for (let i = 0; i < tools.length; i += 40) {
    const batch = tools.slice(i, i + 40);
    try {
      const text = await ask(PROMPT + batch.map((t) => `### ${t.server}/${t.name}\n${t.decl}`).join("\n\n"));
      const obj = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      for (const t of batch) {
        const v = obj[`${t.server}/${t.name}`];
        if (v === "read" || v === "write") verdicts.set(`${t.server}/${t.name}`, v);
      }
    } catch (e) {
      errors.push(`classify: ${e instanceof Error ? e.message : e}`);
    }
  }
  return verdicts;
}
