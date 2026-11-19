# codebridge — local Code Mode for every MCP server in Claude Code

Date: 2026-11-20 · Status: draft for approval

## 1. Intent

Cut the tokens Claude Code spends on MCP tools as far as possible, using the Code Mode idea from Cloudflare
(the model writes a short script that calls many tools inside a sandbox; only the final answer returns).
It has to work for any MCP server, and it is kept sharp by a background refresh job instead of being a
one-time setup.

Why not just rely on what exists:
- Claude Code (2.1.328) already defers MCP tool schemas (tool search), so the "schemas up front" cost is
  mostly gone. The remaining cost is per-call: one round trip per tool call, every intermediate result
  pasted into context, and noisy outputs (big JSON, base64). That is what this project attacks.
- Cloudflare's own runtime (Dynamic Workers) cannot spawn local stdio servers, and its local mode is not a
  security boundary. Existing local bridges each miss something (pctx: 10 s timeout, unconfirmed OAuth;
  ruifung bridge: weak default sandbox; elusznik: stdio + Python only; tmustier: archived, no sandbox).

## 2. Goals, non-goals, anti-goals

Goals
- G1 Wrap any MCP server: stdio, Streamable HTTP, legacy SSE, with bearer tokens or OAuth.
- G2 Expose a handful of tools to Claude Code; the always-loaded footprint stays under ~1,000 tokens.
- G3 One `execute` call can run many upstream calls, with only the script's return value coming back.
- G4 A refresh job keeps four things current: tool catalog, saved recipes, usage ranking, output trimming rules.
- G5 Writes pause for the user's yes/no; reads run freely.
- G6 Measurable: a benchmark proves the token saving against direct MCP use.

Non-goals
- Not a hosted/remote service; runs only on this machine for this user.
- No GUI. CLI + MCP only.
- Not replacing Claude Code's built-in tools (Read, Bash, etc.).

Anti-goals (failure even if it "works")
- Any write/destructive action happening without the user's explicit yes.
- Credentials or tokens visible to sandboxed code, logs, or Claude's context.
- Losing tools: a server that worked directly but can't be reached through the bridge and isn't left in place.
- Net token *increase* on the benchmark.

## 3. Constraints

- Machine: CachyOS, Node 26.13, Deno 2.9.8, Bun 1.4, Docker 29, Podman 6.2, systemd user session.
- Claude Code: server `instructions` are truncated beyond ~4,096 characters (v2.1.296+) — this is the budget
  for the always-loaded summary. Elicitation is supported but has had bugs, so it can't be the only approval path.
- `@cloudflare/codemode` (MIT, 0.5.6, experimental): its main entry imports `cloudflare:workers` and may not
  load in Node; `./mcp` (`codeMcpServer`) and the `Executor` interface are runtime-agnostic. Use only the
  parts that load in Node; pin the version.
- Node has built-in `node:sqlite` with FTS5 (verified on this machine) — no database dependency.
- User's coding rules: smallest working code, no speculative options, tests for non-trivial logic.

## 4. Approaches considered

| | Approach | Trade-off | Verdict |
|---|---|---|---|
| A | Adopt pctx, add refresh/recipes on top | Least code; but 10 s timeout, its tool layout, OAuth unconfirmed, Rust codebase to extend | Rejected |
| B | Own bridge: Node + parts of `@cloudflare/codemode` + Deno sandbox | ~1–1.5k lines to own; fits every requirement | **Chosen by user** |
| C | Cloudflare runtime locally via `wrangler dev` | Faithful to Cloudflare, but no stdio upstreams and not a security boundary | Rejected |

## 5. Design

### 5.1 Shape

```
Claude Code ──stdio──▶ codebridge (Node, long-lived, one per Claude Code session)
                         ├─ Upstream manager ──▶ stdio servers (spawned lazily)
                         │                    └─▶ HTTP/SSE servers (+ OAuth tokens)
                         ├─ Catalog (SQLite + FTS5, ~/.local/share/codebridge/catalog.db)
                         ├─ Sandbox runner ──NDJSON over stdio──▶ deno (all permissions denied)
                         ├─ Approval gate (elicitation → fallback pause/approve)
                         └─ Output shaper (trim rules + size cap + result stash)
codebridge refresh  ◀── systemd --user timer (hourly) + on-demand CLI
```

### 5.2 Tools exposed to Claude Code (only these)

| Tool | Purpose |
|---|---|
| `search(query, limit?)` | Ranked one-liners `server.tool — summary` from the catalog (FTS5 + usage boost). Includes recipes. |
| `describe(names[])` | TypeScript declarations for just those tools/recipes. |
| `execute(code, timeout_ms?)` | Run an async JS/TS function body in the sandbox. Globals: one namespace per server (`vercel.list_deployments({...})`), `recipes.*`, `stash.get(id)`, `console.*`. Returns `{status: completed|paused|error, result, logs, stashed?}`. |
| `approve(run_id, decision)` | Fallback approval path (see 5.5). |
| `save_recipe(name, code, description)` | Save a working script as a named recipe. |

Server `instructions` (always loaded, ≤ 3,500 chars): how to use the five tools in 5 lines, then the
top-N tools and recipes by usage as one-liners. This list is rewritten by the refresh job.

### 5.3 Upstream servers

- Config `~/.config/codebridge/servers.json`, format = Claude Code's `mcpServers` shape
  (`command/args/env` or `type: http|sse, url, headers`). `codebridge import` copies entries from
  `~/.claude.json` (read-only; never edits Claude Code config itself).
- `import` copies `env`/`headers` values as-is into `servers.json`, which is written mode 0600; values
  are never logged, never sent to the sandbox, and redacted in `codebridge status`. Values of the form
  `${VAR}` are resolved from the bridge's environment at connect time.
- Per-server overrides: `alias`, `disabled`, `tools.<name>.access: read|write`, `timeoutMs`.
- Names in scripts: server namespace = `alias` if set, else the server name lowercased with every
  non-`[a-z0-9]` run replaced by `_` (`claude.ai Gmail` → `claude_ai_gmail`); tool names get the same
  treatment. Collisions are an error at refresh time that names both entries and asks for an `alias`.
  The mapping is stored in the catalog so it never shifts silently; recipes depend on it.
- Stdio servers start on first use and stay up for the bridge's lifetime; restarted once on crash.
- HTTP via MCP TS SDK client transports. OAuth via the SDK's client auth provider (dynamic client
  registration + PKCE). `codebridge login <server>` runs the browser flow with a localhost callback.
  Tokens stored in `~/.local/share/codebridge/tokens/<server>.json`, mode 0600, auto-refreshed.
- claude.ai connectors (Gmail, Drive, Docs, Sheets, Slides, Calendar, Zoom, Ticket Tailor): attempt the same
  OAuth flow against their endpoints. If a provider refuses dynamic registration (likely for Google), the
  server is marked `unsupported` in the catalog with the reason, and it stays available through claude.ai
  as today. Supplying a user-created Google OAuth client id is allowed via config but is not required.
- Non-tool MCP features: tool results may carry images/resources — text parts go to the script as strings,
  `structuredContent` as objects, binary parts as `{type, mimeType, stashId}` (never inline base64).
  Resources/prompts of upstreams are out of scope for v1 (listed in catalog only if trivial — builder's call).

### 5.4 Sandbox

- One `deno run` subprocess per `execute`, flags: `--no-prompt --no-config --no-remote --no-npm
  --deny-net --deny-read --deny-write --deny-env --deny-run --deny-ffi --deny-sys`,
  `--v8-flags=--max-old-space-size=256`, cwd = tmpdir, minimal env.
- Tool calls cross the boundary as NDJSON messages (`call`/`ret`/`log`/`done`), modelled on
  codemode-deno-executor (MIT) but written in-repo. Implements the `@cloudflare/codemode` `Executor`
  interface so the codemode helpers stay usable.
- Limits: default timeout 60 s (cap 300 s), stdout cap 10 MB, max 200 upstream calls per run.
- TypeScript is accepted (Deno strips types). No type-check pass in v1.

### 5.5 Approval gate (writes pause, reads run)

- Classification, first match wins: user override in config → MCP annotations
  (`readOnlyHint: true` = read; `destructiveHint`/`readOnlyHint: false` = write) → name heuristic
  (`get|list|search|read|query|fetch|describe|count|find|stat` prefixes = read) → **unknown = write**.
- On a write call inside a script:
  1. If Claude Code advertised elicitation: send an elicitation request showing server, tool and
     arguments; accept → call proceeds; decline/cancel → the call throws `ApprovalDenied` in the script.
  2. Otherwise (or if elicitation errors): `execute` returns `status: paused` with `run_id` and the
     pending call, while the Deno process **stays alive, blocked on that one call** (no re-run, no
     replay, so `Date.now()`, randomness and earlier reads need no special handling). The run's
     timeout clock stops while paused; an unanswered pause is killed after 15 min. Claude calls
     `approve(run_id, "yes"|"no")`; the user sees Claude Code's normal permission prompt for it.
     Yes → the call executes and the script continues; `approve` returns what `execute` would have
     (completed, error, or the next pause). No → the call throws `ApprovalDenied` inside the script.
- Accepted risk (user decision): the fallback relies on Claude Code's permission prompt. In auto mode,
  or if `mcp__codebridge__approve` is ever allow-listed, that prompt may not appear. The README and
  `codebridge status` state this plainly, and `codebridge` never adds itself to any allow-list.
- Concurrency inside a script: reads may run concurrently (`Promise.all`); writes are serialised —
  a second write waits until the first is approved/denied. A run has at most one pending approval.
- Every write (approved or denied) is appended to `~/.local/share/codebridge/audit.log`.

### 5.6 Output shaping (token control)

- Script return value is serialised compactly (no pretty-printing) and capped at ~4,000 tokens
  (chars/4 estimate). Excess is stored and replaced by `{truncated: true, stashId}`; `stash.get(id)` in a
  later `execute` reads it.
- Trim rules, applied to each upstream result *before* the script sees it, so scripts stay simpler:
  mechanical rules only — drop `null`/empty fields, replace strings > 2 KB that look like base64 with
  stash refs, drop keys listed per tool. Per-tool key-drop rules are *proposed* by refresh and applied only
  after the user accepts them (`codebridge rules accept`), so nothing meaningful silently disappears.

### 5.7 Refresh job (`codebridge refresh`)

Runs hourly via a systemd user timer and on demand. Steps:
1. Catalog: connect to each enabled server, `tools/list`, hash each tool's schema; on change regenerate
   its one-line summary and TypeScript declaration and update FTS5. Servers that fail keep their last
   good catalog entry, marked stale.
2. Recipes: for every recipe, confirm each tool it calls still exists, and run `deno check` against the
   current declarations; broken recipes are flagged `broken` (excluded from search, reported).
3. Usage ranking: recompute scores from the call log (recency-weighted count) and rewrite the
   instructions top-N list.
4. Trim rules: from the logged sizes of recent upstream results, propose key-drop rules for keys that are
   large and never read by scripts (detected by property-access tracking in the sandbox proxy) — builder
   may simplify to "large and repeated" if access tracking is costly.
5. Write a short report (`codebridge status`): servers up/stale/unsupported, changed tools, broken recipes,
   pending rule proposals.

Shared state: several bridge processes (one per Claude Code session) and the refresh job share
`catalog.db` (SQLite WAL mode, busy timeout). Bridges read the catalog per `search`/`describe`, so new
tools and recipes show up immediately; the server `instructions` text is fixed at MCP handshake, so a
new top-N list takes effect from the next session (accepted).

Logs kept: call log (tool, duration, result size, run id; no arguments or results for privacy), 30-day
retention. Run logs for replay: deleted after completion or 24 h.

### 5.8 Cutover (later, user-driven)

Bridge is first added *alongside* existing servers. After the benchmark shows a saving, the user decides
per server whether to remove its direct entry from Claude Code. `codebridge` never edits Claude Code config.
`codebridge verify <server>` must pass first: connects, lists tools, compares the count with what the
server reports directly, and runs one read-only call if one exists. `status` lists servers that are
`unsupported` or stale with the line "keep the direct entry".

### 5.9 Benchmark (proof of G6)

`bench/` holds ~6 fixed tasks across vercel, codegraph and mempalace (read-only). Each runs twice via
`claude -p --output-format stream-json`: once with the direct servers only, once with codebridge only.
Report input+output tokens, tool calls, wall time and task success (checked by assertions on the answer).
Pass bar: ≥ 30 % fewer total tokens with equal task success.
Conditions: catalog refreshed before the run (warm catalog is the real-world state); **no recipes** in
the primary measurement. A second, separately reported run adds recipes saved while solving a
different, disjoint task set, to show the recipe effect without inflating the primary number.

## 6. Decided by the user

- Build our own (approach B).
- Refresh covers all four: catalog, recipes, usage ranking, trimming rules.
- Writes pause and ask; reads run freely. Claude Code's permission prompt on `approve` is an acceptable
  fallback gate (no out-of-band desktop dialog).
- Scope: every Claude Code server, and try the claude.ai connectors too, falling back to claude.ai where
  sign-in doesn't work.
- Nothing is changed in the current Claude Code setup until the user says so.

## 7. My calls (check these)

- Name `codebridge`; repo `~/Projects/codebridge`; TypeScript on Node 26; deps limited to
  `@modelcontextprotocol/sdk`, `@cloudflare/codemode` (pinned), `zod`.
- Deno subprocess sandbox rather than Docker (fast startup, strong enough with all permissions denied;
  Docker remains possible later).
- Unknown tools count as writes.
- Hourly refresh; 4k-token result cap; 60 s default timeout.
- Trim rules beyond mechanical ones need the user's acceptance.
- Upstream resources/prompts out of v1.

- First build step is a spike: does `@cloudflare/codemode` (pinned) load in Node 26 without
  `cloudflare:workers`? If not, drop the dependency entirely and keep an in-repo interface with the
  same shape as its `Executor` (no `codeMcpServer`; our own MCP server is written with the MCP SDK anyway).
- Paused runs keep the sandbox process alive (no replay); reads concurrent, writes serialised.

## 8. Left to the builder

- Exact JSON-Schema → TypeScript conversion (use codemode's helper if it loads in Node, else a small converter).
- FTS5 ranking weights and usage-boost formula.
- Recipe storage format (one `.ts` file per recipe with a JSDoc header is suggested).
- Process supervision details for stdio upstreams.

## 9. Risks

- `@cloudflare/codemode` is experimental; pinning + thin use limits exposure.
- Elicitation behaviour in Claude Code has changed across versions; the pause/approve fallback covers it.
- Fallback approval can be skipped in auto mode or by an allow-list rule (accepted by the user; documented).
- Paused runs hold a Deno process (≤ 256 MB) for up to 15 min each.
- Google-hosted connectors may refuse third-party OAuth; designed to fall back.
- The bridge process holds OAuth tokens for many services — files are 0600 and never enter the sandbox.
