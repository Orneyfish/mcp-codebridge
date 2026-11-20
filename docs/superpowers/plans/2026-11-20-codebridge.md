# codebridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local Code Mode MCP bridge: Claude Code connects to one stdio server exposing five tools (`search`, `describe`, `execute`, `approve`, `save_recipe`). Scripts run in a locked-down Deno subprocess and call any upstream MCP server. Writes pause for approval, and an hourly refresh job keeps the catalog, recipes, ranking and trim rules current.

**Architecture:** A Node 26 process runs TypeScript sources directly (native type stripping, no build step). It holds an upstream manager (MCP SDK clients), a SQLite+FTS5 catalog (`node:sqlite`, WAL), a Deno sandbox executor speaking NDJSON over stdio, an approval gate, and an output shaper with a file stash. The `codebridge` CLI serves MCP (no args) and runs `refresh`, `login`, `import`, `verify`, `status` and `rules`.

**Tech Stack:** Node v26.13.1 (`node:sqlite`, `node:test`, type stripping), Deno 2.9.8, `@modelcontextprotocol/sdk@1.32.2`, `zod@4.6.7`.

**Spec:** `docs/superpowers/specs/2026-11-20-codebridge-design.md` (sections 6 and 7 are settled. This plan makes the section 8 calls, listed under "Builder decisions" below.)

## Global Constraints

- Repo is `~/Projects/mcp-codebridge`, the directory this session was opened in and the user set up for this project. The design names `~/Projects/codebridge`, and only the folder name differs. Work happens on branch `build/codebridge`.
- Runtime dependencies: only `@modelcontextprotocol/sdk` (pinned `1.32.2`) and `zod` (pinned `4.6.7`). Add no devDependencies, including `typescript` and `@types/*`. Ask the user before adding any dependency.
- Sources are `.ts`, run with `node` directly. Use erasable syntax only: no `enum`, no `namespace`, no constructor parameter properties. Relative imports carry the `.ts` extension. Tests run with `node --test 'test/**/*.test.ts'`.
- Never edit `~/.claude.json`, `~/.claude/settings*.json`, or any Claude Code config, and never add codebridge tools to an allow-list. `import` only reads `~/.claude.json`.
- Upstream secrets (env, headers, tokens) are never logged, never printed, and never reach the sandbox. `servers.json`, token files and `audit.log` are mode `0600`, and their directories are `0700`.
- Tool classification order: config override, then annotations, then name heuristic, then **unknown = write**.
- Tests and the benchmark make read-only upstream calls only. Never trigger a write on a real server (vercel, cloudflare, Gmail, and so on). Write paths are tested only against the in-repo fixture server.
- Sandbox flags (exact): `--no-prompt --no-config --no-remote --no-npm --deny-net --deny-read --deny-write --deny-env --deny-run --deny-ffi --deny-sys --v8-flags=--max-old-space-size=256`. The cwd is a fresh tmpdir. The env is exactly `{PATH, NO_COLOR: "1", DENO_NO_UPDATE_CHECK: "1", DENO_DIR: <run tmpdir>/.deno}`.
- Limits: default timeout 60 000 ms, cap 300 000 ms. Stdout cap 10 MiB. Max 200 upstream calls per run. Result cap 4 000 tokens (chars/4 = 16 000 chars). Base64 stash threshold 2 048 chars. An unanswered pause is killed after 15 min. Server `instructions` are at most 3 500 chars.
- Paths follow XDG and are read from env at call time, so tests can redirect them: config `$XDG_CONFIG_HOME/codebridge` (default `~/.config/codebridge`), data `$XDG_DATA_HOME/codebridge` (default `~/.local/share/codebridge`).
- Each step is proved by command output run in the session, not by claims.

## Spike result (step a, run 2026-11-20 before writing this plan)

`npm i @cloudflare/codemode@0.5.6` in a scratch dir, then importing it in Node 26:
- `@cloudflare/codemode` fails with `Received protocol 'cloudflare:'`.
- `@cloudflare/codemode/mcp` fails with `Cannot find package '@cfworker/json-schema'`, which would mean adding a dependency.

**Decision (per design §7): drop `@cloudflare/codemode`.** `src/executor.ts` keeps an in-repo interface with the same shape as its `Executor`: `execute(code, fns, options?) → Promise<{result, error?, logs?}>`. Task 1 records this in `docs/spike-codemode.md`.

The same session also verified that all SDK entry points used below load in Node 26 (`client/index.js`, `client/stdio.js`, `client/streamableHttp.js`, `client/sse.js`, `client/auth.js`, `server/mcp.js`, `server/stdio.js`). It also verified that `deno run` with the exact flags above loads a `.ts` main module from a file and strips types, even with `--deny-read`.

## Builder decisions (design §8 and gaps)

- **JSON Schema → TS:** a small in-repo converter (`src/catalog/tsdecl.ts`). `$ref` and unknown constructs become `unknown`. When a tool has an `outputSchema`, `describe` uses it as the return type.
- **Ranking:** FTS5 over (`ident`, `summary`, `description`) with `bm25(tools_fts, 10, 5, 1)`. The final order is `bm25 - 2.0 * ln(1 + usage)`, where `usage = Σ exp(-age_days / 7)` over call-log rows. Refresh recomputes it.
- **Recipes:** one file per recipe, `<data>/recipes/<name>.ts`. Line 1 is a JSDoc header `/** @description <text> */` and the rest is the function body. The body receives `args` and runs inside the same sandbox run as an inlined `async (args) => { body }`. Only recipes referenced as `recipes.<name>` in the submitted code are inlined.
- **Stdio supervision:** spawn lazily through the SDK `StdioClientTransport` with `stderr: "ignore"`. On transport close, the next call reconnects once. A second crash marks the server `failed` for the bridge's lifetime.
- **Trim-rule proposals:** use the design's allowed simplification, "large and repeated". A top-level key (or a key of array items) with average size ≥ 2 000 bytes over ≥ 5 calls of the same tool gets proposed. There is no property-access tracking.
- **Upstream result → script value:** `isError` throws `Error(text)`. Otherwise `structuredContent` is used if present. A single text part is `JSON.parse`d if it parses, else kept as a string. Several parts become an array. Binary parts become `{type, mimeType, stashId}`.
- **Audit log:** JSONL lines `{ts, run_id, server, tool, args, decision, via}`, with `args` JSON truncated to 500 chars and the file at mode 0600.
- **OAuth:** a fixed loopback callback, `http://127.0.0.1:47823/callback`, so a registered `redirect_uri` stays valid across logins. All `http`/`sse` servers get the provider. At serve time, `redirectToAuthorization` throws `NeedsLogin`.
- **Name collisions:** a server namespace collision skips both servers and reports `set "alias" on <a> or <b>`. A tool-ident collision inside one server keeps the first tool (by name sort) and reports the second one.

## Review Focus

1. **Upstream returns non-JSON text, deeply nested or huge JSON, or an empty content array.** Expected: the script gets a sensible value, the result is capped and stashed, and nothing throws in the bridge. Owner: Task 6.
2. **Script has a syntax error, throws, never resolves, returns `undefined`, or writes raw text to stdout through `Deno.stdout`.** Expected: `status: error` (or `completed` with `result: null`), a readable message, and the Deno process gone afterward. Owner: Task 2.
3. **Upstream stdio command missing, or the upstream crashes mid-call.** Expected: the call throws in the script with the server name, the bridge stays up, and one restart is attempted. Owner: Task 4.
4. **`approve` called with an unknown or expired `run_id`, or called twice for the same pause.** Expected: a clear error, and the write runs at most once. Owner: Task 8.
5. **Two bridges plus refresh write `catalog.db` at once.** Expected: no `SQLITE_BUSY` thrown, thanks to WAL and `busy_timeout = 5000`. Owner: Task 5.

---

## File Structure

```
package.json, .gitignore, README.md
src/cli.ts                 entry; `#!/usr/bin/env node`; subcommand dispatch
src/paths.ts               XDG paths + writeSecretFile
src/executor.ts            Executor interface (codemode shape)
src/sandbox/deno.ts        DenoExecutor (Node side)
src/sandbox/prelude.ts     PRELUDE source string injected into each run module
src/config.ts              servers.json schema, ${VAR} resolution, toIdent/namespaceOf
src/upstream/manager.ts    Upstreams: lazy connect, list/call, restart-once
src/upstream/oauth.ts      FileOAuthProvider, login(), NeedsLogin
src/catalog/db.ts          openDb (schema, WAL, busy timeout)
src/catalog/tsdecl.ts      schemaToTs, toolDecl
src/catalog/catalog.ts     Catalog class (tools, search, describe, calls, rules, recipes, meta)
src/gate/classify.ts       classify()
src/gate/audit.ts          appendAudit()
src/shape.ts               toScriptValue, trim, cap, keySizes
src/stash.ts               Stash
src/runs.ts                Runs: execute/approve orchestration, write mutex, pause registry
src/instructions.ts        buildInstructions()
src/recipes.ts             saveRecipe, recipePrelude, checkRecipes
src/server.ts              createServer(deps) → McpServer with the five tools
src/refresh.ts             refresh()
src/commands.ts            importServers, verify, status, rulesCmd
systemd/codebridge-refresh.service, systemd/codebridge-refresh.timer
test/fixtures/fixture-server.ts   test MCP server (stdio or HTTP via argv)
test/helpers.ts            tmpHome(): sets XDG_* to a temp dir
test/*.test.ts
bench/tasks.json, bench/run.ts, bench/README.md
```

---

### Task 1: Scaffold, paths, spike record

**Files:**
- Create: `package.json`, `.gitignore`, `src/paths.ts`, `test/helpers.ts`, `test/paths.test.ts`, `docs/spike-codemode.md`

**Interfaces:**
- Produces: `paths(): {configDir, dataDir, serversFile, catalogDb, tokensDir, recipesDir, stashDir, auditLog}`. Every member is an absolute string computed from `process.env` at call time.
- Produces: `writeSecretFile(file: string, data: string): void`. It creates parent dirs at mode 0700, writes the file at mode 0600, and chmods an existing file to 0600.
- Produces: `tmpHome(): string` (test helper). It sets `XDG_CONFIG_HOME` and `XDG_DATA_HOME` to a fresh `mkdtemp` and returns its root.

- [ ] **Step 1:** Write `package.json` with `{"name":"codebridge","type":"module","private":true,"bin":{"codebridge":"src/cli.ts"},"scripts":{"test":"node --test 'test/**/*.test.ts'"},"dependencies":{"@modelcontextprotocol/sdk":"1.32.2","zod":"4.6.7"}}`. Write `.gitignore` with `node_modules/`, `bench/out/`, `.claude/`. Run `npm i`.
- [ ] **Step 2:** Write `test/paths.test.ts`:
  - `paths honours XDG`: after `tmpHome()`, `paths().serversFile === <root>/config/codebridge/servers.json` and `paths().catalogDb === <root>/data/codebridge/catalog.db`.
  - `writeSecretFile modes`: after writing, `statSync(file).mode & 0o777 === 0o600` and the parent dir mode is `0o700`. A pre-existing file at 0644 ends at 0600.
- [ ] **Step 3:** Run `npm test`. Expected: FAIL (module not found).
- [ ] **Step 4:** Implement `src/paths.ts` and `test/helpers.ts`.
- [ ] **Step 5:** Run `npm test`. Expected: PASS.
- [ ] **Step 6:** Write `docs/spike-codemode.md`, about 10 lines covering the two failure messages above, the decision, and the mirrored interface.
- [ ] **Step 7:** Commit: `git add -A && git commit -m "chore: scaffold codebridge, XDG paths, codemode spike record"`. Leave `.claude/` and `mempalace.yaml` uncommitted. `.claude/` is gitignored, so leave `mempalace.yaml` unstaged by hand.

### Task 2: Deno sandbox executor

**Files:**
- Create: `src/executor.ts`, `src/sandbox/prelude.ts`, `src/sandbox/deno.ts`, `test/sandbox.test.ts`

**Interfaces:**
- Produces (`src/executor.ts`):
  ```ts
  export interface ExecuteResult { result: unknown; error?: string; logs?: string[] }
  export type Fns = Record<string, (args: unknown) => Promise<unknown>>;
  export interface ExecuteOptions { timeoutMs?: number; clock?: { paused: boolean }; prelude?: string; signal?: AbortSignal }
  export interface Executor { execute(code: string, fns: Fns, options?: ExecuteOptions): Promise<ExecuteResult> }
  ```
- Produces: `class DenoExecutor implements Executor` and constants `DEFAULT_TIMEOUT_MS = 60_000`, `MAX_TIMEOUT_MS = 300_000`, `STDOUT_CAP = 10 * 1024 * 1024`, `MAX_CALLS = 200`.
- Protocol: child→parent lines on stdout are `{"t":"call","id":n,"fn":"ns.tool","args":…}`, `{"t":"log","level":"log|warn|error","msg":string}`, and `{"t":"done","ok":true,"result":…}` or `{"t":"done","ok":false,"error":string}`. Parent→child lines on stdin are `{"t":"ret","id":n,"ok":true,"value":…}` or `{"t":"ret","id":n,"ok":false,"error":string}`. Non-JSON stdout lines go to `logs`.

How a run works: write `<tmpdir>/run.ts` containing `PRELUDE` + `const __ns = <JSON of namespace→tool idents from fns keys>;` + `options.prelude ?? ""` + `async function __main() {\n<code>\n}` + `__run(__main);`, then spawn `deno run <flags> run.ts` with cwd and env per Global Constraints. The prelude does three things. It defines each namespace as a global object whose methods send `call` and await `ret`. It overrides `console.*` to emit `log`. Its `__run` awaits main and emits `done`, with `undefined` sent as `null`. Fn keys that contain a dot (`ns.tool`, `recipes.x`, `stash.get`) all become globals this way. The timeout counts only time while `clock.paused` is false (250 ms ticker). Timeout, abort, stdout cap or exit kills the child with SIGKILL and removes the tmpdir. A child exit without `done` → `error` = `"sandbox exited: " +` the last 2 000 chars of stderr.

- [ ] **Step 1:** Write `test/sandbox.test.ts` (each test uses `new DenoExecutor()`):
  - `returns value`: `return 1+1` → `{result: 2}`
  - `accepts TypeScript`: `const x: number = 3; return x` → `result 3`
  - `undefined → null`: `return` → `result === null`, no error
  - `tool round trip`: fns `{"srv.echo": async a => ({got: a})}`, code `return await srv.echo({x:1})` → `{got:{x:1}}`
  - `tool error surfaces`: fn throws `Error("boom")`, code `try { await srv.echo({}) } catch (e) { return e.message }` → `"boom"`
  - `concurrent calls`: `Promise.all` of 3 calls to a fn with a 50 ms delay → all 3 results, total < 140 ms
  - `logs captured`: `console.log("hi", {a:1}); return 0` → `logs` contains `'hi {"a":1}'`
  - `timeout`: `await new Promise(()=>{})` with `timeoutMs: 300` → `error` matches `/timeout after 300ms/`, settles within 1.5 s
  - `paused clock`: `clock = {paused: true}` and a fn that waits 600 ms, with `timeoutMs: 300` → completes OK
  - `memory limit`: `const a=[]; while(true) a.push(new Array(1e6).fill(1))` → `error` is set, settles within 20 s
  - `output cap`: `while(true) Deno.stdout.writeSync(new Uint8Array(1<<20))` → `error` matches `/output cap/`
  - `call limit`: 201 sequential calls → the 201st throws `"call limit (200) reached"`, so the script catches and returns the index 200
  - `denied net/fs/env/run`: each of `await fetch("https://example.com")`, `Deno.readTextFileSync("/etc/hostname")`, `Deno.env.get("HOME")`, `new Deno.Command("ls").outputSync()` rejects or throws with `NotCapable` or `PermissionDenied`. Assert via the caught `e.name`.
  - `secret env not leaked`: set `process.env.CODEBRIDGE_TEST_SECRET="s3cr3t"` in the parent, then in the script `try { return Deno.env.toObject() } catch { return "denied" }` → `"denied"`
  - `syntax error`: code `return (` → `error` is set and contains `SyntaxError` or `parse`
  - `no leftover processes`: after the timeout test, `pgrep -f run.ts` under the test's tmpdir prefix finds nothing
  - `abort signal`: `signal` aborted after 100 ms → `error` matches `/aborted/`
- [ ] **Step 2:** Run `node --test test/sandbox.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement `src/executor.ts`, `src/sandbox/prelude.ts` and `src/sandbox/deno.ts` as described above.
- [ ] **Step 4:** Run `node --test test/sandbox.test.ts`. Expected: all PASS. Paste the summary line.
- [ ] **Step 5:** Commit: `feat: Deno sandbox executor with NDJSON tool bridge and limits`.

### Task 3: Server config and naming

**Files:**
- Create: `src/config.ts`, `test/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type Overrides = { alias?: string; disabled?: boolean; timeoutMs?: number; tools?: Record<string, { access: "read" | "write" }>; oauth?: { clientId?: string } };
  export type ServerEntry = ({ type?: "stdio"; command: string; args?: string[]; env?: Record<string,string> } | { type: "http" | "sse"; url: string; headers?: Record<string,string> }) & Overrides;
  export function loadServers(file?: string): Record<string, ServerEntry>   // file shape {"mcpServers": {...}}; missing file → {}; zod-validated (passthrough unknown keys)
  export function saveServers(servers: Record<string, ServerEntry>, file?: string): void  // via writeSecretFile
  export function resolveVars(rec: Record<string,string> | undefined, env: NodeJS.ProcessEnv): Record<string,string>  // "${VAR}" and "...${VAR}..." substitution; missing var → throws Error naming the VAR, not its value
  export function toIdent(s: string): string      // lowercase, /[^a-z0-9]+/g → "_", leading digit → "_" prefix
  export function namespaceOf(name: string, e: ServerEntry): string  // alias ?? toIdent(name)
  ```

- [ ] **Step 1:** Write tests:
  - `toIdent("claude.ai Gmail") === "claude_ai_gmail"`, `toIdent("list-deployments") === "list_deployments"`, `toIdent("3d") === "_3d"`
  - `namespaceOf("X", {command:"a", alias:"y"}) === "y"`
  - `resolveVars({A:"Bearer ${TOK}"}, {TOK:"t"})` → `{A:"Bearer t"}`, and a missing var throws a message that contains `TOK` and does not contain any value
  - `loadServers` round-trips `saveServers`, the file mode is 0600, a missing file → `{}`, and an invalid entry (no command/url) throws naming the server
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `feat: servers.json config, var resolution, naming scheme`.

### Task 4: Upstream manager (stdio, then HTTP/SSE) and fixture server

**Files:**
- Create: `test/fixtures/fixture-server.ts`, `src/upstream/manager.ts`, `test/upstream.test.ts`

**Interfaces:**
- Consumes: `ServerEntry`, `resolveVars` (Task 3).
- Produces:
  ```ts
  export class Upstreams {
    constructor(servers: Record<string, ServerEntry>);
    listTools(server: string): Promise<Tool[]>;            // SDK Tool type, all pages
    callTool(server: string, tool: string, args: unknown): Promise<CallToolResult>;  // honours entry.timeoutMs
    state(server: string): "idle" | "up" | "failed";
    close(): Promise<void>;
  }
  ```
  Errors thrown here always start with `"<server>: "`.
- Fixture server: `node test/fixtures/fixture-server.ts [--http <port> | --sse <port>]` (default stdio), built with the SDK `McpServer`. Its tools:
  - `get_item({id: string})`, annotated `readOnlyHint: true`, returns JSON text `{id, name:"item "+id, empty:null, tags:[]}`
  - `list_items({})` returns `structuredContent` `{items:[{id:"1",blob:"x".repeat(3000)}, …5]}`
  - `delete_item({id})`, annotated `destructiveHint: true`, returns text `deleted <id>`
  - `make_thing({})`, unannotated, returns text `made`
  - `image_tool({})` returns an image content part (base64 PNG)
  - `fail_tool({})` returns `isError` with text `nope`
  - `crash({})` calls `process.exit(1)`
  - `slow({ms:number})` sleeps
  - `echo_env({})` returns `process.env.FIXTURE_SECRET ?? "unset"`

  Every call appends the tool name to the file named by env `FIXTURE_LOG`, if set, so tests can count real executions.

- [ ] **Step 1:** Write the fixture server. Smoke-check it by connecting through `Upstreams` in the test, not by hand.
- [ ] **Step 2:** Write `test/upstream.test.ts`:
  - `stdio lazily starts`: `state("fx") === "idle"` before the first call. After `listTools` there are 9 tools and the state is `"up"`.
  - `env passed through`: entry `env: {FIXTURE_SECRET: "${CB_T}"}` with `process.env.CB_T="abc"` → `echo_env` text is `"abc"`
  - `restart once`: `crash` → rejects, `get_item` succeeds afterward, a second `crash` then `get_item` → rejects with `/fx: .*failed/`, state is `"failed"`
  - `missing command`: entry `{command:"/nonexistent"}` → `listTools` rejects with a message starting `"bad: "`
  - `timeoutMs`: entry `timeoutMs: 200`, `slow({ms:1000})` → rejects within 1 s
  - `streamable http`: spawn the fixture with `--http <free port>`, entry `{type:"http", url:"http://127.0.0.1:<port>/mcp", headers:{Authorization:"Bearer x"}}` → `listTools` has 9 tools, and the fixture logs that it received header `authorization: Bearer x` (assert through a `whoami` field the fixture adds to `get_item` output: `auth` = presence boolean only)
  - `sse`: same with `--sse` and `type:"sse"`
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement `Upstreams`. For http use `StreamableHTTPClientTransport(url, {requestInit:{headers}, authProvider})`, for sse use `SSEClientTransport` with the same options, with `authProvider` from Task 4b wired in that task. Leave `authProvider` undefined in this task. **Step 5:** Run → PASS.
- [ ] **Step 6:** Commit: `feat: upstream manager for stdio/http/sse with restart-once`.

### Task 4b: OAuth provider and `login`

**Files:**
- Create: `src/upstream/oauth.ts`, `test/oauth.test.ts`
- Modify: `src/upstream/manager.ts` (pass `new FileOAuthProvider(name, {interactive:false, clientId: e.oauth?.clientId})` for http/sse)

**Interfaces:**
- Produces:
  ```ts
  export const CALLBACK_URL = "http://127.0.0.1:47823/callback";
  export class NeedsLogin extends Error {}          // message: `<server>: run "codebridge login <server>"`
  export class FileOAuthProvider implements OAuthClientProvider {  // state in paths().tokensDir/<server>.json via writeSecretFile: {client?, tokens?, verifier?}
    constructor(server: string, opts: { interactive: boolean; clientId?: string; onRedirect?: (u: URL) => void });
  }
  export async function login(server: string, entry: ServerEntry): Promise<{ ok: true } | { unsupported: string }>
  ```
  `login` starts the loopback server on 47823 and calls SDK `auth(provider, {serverUrl})`. On `"REDIRECT"` it opens the URL with `xdg-open` and prints it, waits for `?code=` (5 min limit), then calls `auth(provider, {serverUrl, authorizationCode})`. An error whose message matches `/dynamic client registration|registration_endpoint|does not support/i` → `{unsupported: message}`. The caller (CLI) writes that to the catalog.

- [ ] **Step 1:** Write tests:
  - `token file 0600 and round-trip`: `saveTokens({access_token:"a", token_type:"bearer"})` → a new provider instance's `tokens()` returns them, and the file mode is 0600
  - `clientId override`: `clientInformation()` → `{client_id: "cid"}` when `clientId: "cid"`, with no DCR
  - `non-interactive redirect throws NeedsLogin`
  - `DCR refused → unsupported`: a local `node:http` server answers `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` with metadata that has no `registration_endpoint`, and `/mcp` with 401 → `login()` resolves `{unsupported: <string>}`
  - `tokens never logged`: capture `console.log`/`console.error` during login, and the output contains no `access_token` value
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS, and re-run `test/upstream.test.ts` to confirm it still passes.
- [ ] **Step 5:** Commit: `feat: file-backed OAuth provider and login flow`.

### Task 5: Catalog, declarations, search/describe

**Files:**
- Create: `src/catalog/db.ts`, `src/catalog/tsdecl.ts`, `src/catalog/catalog.ts`, `src/gate/classify.ts`, `test/tsdecl.test.ts`, `test/classify.test.ts`, `test/catalog.test.ts`

**Interfaces:**
- Produces `classify(tool: {name: string; annotations?: {readOnlyHint?: boolean; destructiveHint?: boolean}}, override?: "read" | "write"): "read" | "write"`. The name rule is `/^(get|list|search|read|query|fetch|describe|count|find|stat)(?:[_\-.A-Z0-9]|$)/`.
- Produces `schemaToTs(schema: unknown): string` and `toolDecl(ident: string, tool: Tool): string`. `toolDecl` returns `/** <summary> */\n<ident>(args: <TS>): Promise<<out TS or unknown>>;`, with property descriptions as one-line `/** */` (≤ 120 chars) and the `summary` = first sentence of the description, ≤ 100 chars.
- Produces `openDb(file = paths().catalogDb): DatabaseSync`. It applies `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;` and these tables:
  - `servers(name PK, ns UNIQUE, status, reason, updated)`
  - `tools(server, name, ident, ns, summary, description, decl, check_decl, access, hash, usage REAL DEFAULT 0, PK(server,name))`
  - `tools_fts` (FTS5: `ident, summary, description`, external content table)
  - `recipes(name PK, description, status, reason)`
  - `calls(ts, server, tool, ms, bytes, run_id)`
  - `key_sizes(server, tool, key, total, n, PK(server,tool,key))`
  - `rules(id INTEGER PK, server, tool, key, status)` where status is `proposed|accepted|rejected`
  - `meta(k PK, v)`
- Produces `class Catalog`:
  ```ts
  constructor(db?: DatabaseSync)
  syncServer(server: string, ns: string, tools: Tool[], overrides?: Record<string,{access:"read"|"write"}>): { changed: string[]; errors: string[] }  // hash = sha256(JSON of name+description+inputSchema+outputSchema+annotations); removed tools deleted; stable ident kept for existing rows
  checkNamespace(server: string, ns: string): string | null       // error text if ns used by another server
  markServer(server: string, status: "up" | "stale" | "unsupported" | "failed", reason?: string): void
  servers(): { name; ns; status; reason }[]
  search(query: string, limit = 10): string[]    // lines "ns.ident — summary [read|write]" and "recipes.x — description [recipe]"; broken recipes excluded
  describe(names: string[]): string             // decls grouped under "// ns" headers; unknown names listed as "// not found: x"
  resolve(ns: string, ident: string): { server: string; tool: string; access: "read" | "write" } | undefined
  checkDeclarations(): string                    // `declare const ns: { ... }` for all tools, with `any` return where no outputSchema (for deno check)
  logCall(c: { server; tool; ms; bytes; runId }): void
  recordKeySizes(server, tool, sizes: Record<string, number>): void
  get(k): string | undefined; set(k, v): void
  // rules + recipes accessors used by Tasks 6, 9, 10:
  dropKeys(server, tool): string[]; proposeRules(minAvg = 2000, minN = 5): number; rules(status?): {id;server;tool;key;status}[]; setRule(id, status): void
  upsertRecipe(name, description, status = "ok", reason?): void; recipes(): {name;description;status;reason}[]
  ```
  Search query handling: split on `/[^A-Za-z0-9]+/`, then quote each term and add `*`, joined with ` OR `. An empty query → top `limit` by usage.

- [ ] **Step 1:** Write tests:
  - classify: `{name:"get_user"}` → read, `{name:"getUser"}` → read, `{name:"listings_create"}` → write (`list` must be followed by a separator), `{name:"stats"}` → write, `{name:"do_x", annotations:{readOnlyHint:true}}` → read, `{name:"get_x", annotations:{destructiveHint:true}}` → write, `{name:"get_x"}` with override `"write"` → write, `{name:"make_thing"}` → write
  - tsdecl: `{type:"object",properties:{id:{type:"string"},n:{type:"integer"}},required:["id"]}` → `{ id: string; n?: number }`; an enum `["a","b"]` → `"a" | "b"`; an array of strings → `string[]`; `$ref` → `unknown`; `anyOf` string/null → `string | null`; and `toolDecl` with `outputSchema` uses it as the return type
  - catalog:
    - sync the fixture's 9 tools (listed once via `Upstreams` and cached in a JSON fixture file to keep the test fast)
    - `search("delete")` first line starts `fx.delete_item` and ends `[write]`
    - `describe(["fx.get_item"])` contains `get_item(args: { id: string })`
    - re-sync with a changed description → `changed` = `["get_item"]`
    - re-sync without `slow` → `resolve("fx","slow")` is undefined
    - `checkNamespace` collision text contains both server names and `alias`
    - usage boost: two tools match equally and the one with `usage=5` ranks first
  - concurrency (`catalog concurrent writers`): spawn 3 child `node` processes that each call `logCall` 500 times on the same db file → all exit 0, and `SELECT count(*) FROM calls` = 1500
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `feat: SQLite/FTS5 catalog, TS declarations, classification`.

### Task 6: Output shaping and stash

**Files:**
- Create: `src/stash.ts`, `src/shape.ts`, `test/shape.test.ts`

**Interfaces:**
- Produces `class Stash { constructor(dir = paths().stashDir); put(v: unknown): string /* 8 hex */; get(id: string): unknown /* throws "stash <id> not found or expired" */; sweep(maxAgeMs = 86_400_000): number }`. Ids are validated `/^[0-9a-f]{8}$/` before touching the fs.
- Produces:
  ```ts
  export function toScriptValue(r: CallToolResult, stash: Stash): unknown  // rules in Builder decisions; isError → throws Error(text joined)
  export function trim(v: unknown, dropKeys: string[], stash: Stash): unknown  // recursively drop null/undefined, "" , [] , {} values in objects; base64-looking strings > 2048 → {stashId, bytes}; dropKeys removed at top level and from objects inside a top-level array or a top-level object's array values
  export function cap(v: unknown, stash: Stash, maxChars = 16_000): { value: unknown; stashed?: string }  // JSON.stringify compact; over cap → {truncated:true, stashId, preview: first 1000 chars}
  export function keySizes(v: unknown): Record<string, number>  // JSON length per top-level key (or per key of array items, summed)
  ```

- [ ] **Step 1:** Write tests:
  - `toScriptValue`: JSON text → object, plain text `"hello"` → `"hello"`, `structuredContent` wins over text, image part → `{type:"image", mimeType:"image/png", stashId}` and `stash.get(stashId)` returns the base64, `isError` throws `"nope"`, empty content → `null`, two text parts → array of two
  - `trim`: `{a:null,b:"",c:[],d:{},e:1}` → `{e:1}`, nested null is dropped, a 3 000-char base64 string → `{stashId, bytes:3000}`, a 3 000-char prose string with spaces is kept, `dropKeys ["blob"]` on `{items:[{id:1,blob:"x"}]}` → `{items:[{id:1}]}`
  - `cap`: a 20 000-char value → `truncated` + `stashId`, `stash.get` returns the full value, and a small value comes back unchanged with no `stashed`
  - `deep nesting`: a 5 000-level nested object doesn't throw out of `trim` or `cap`. Use an iterative or depth-limited walk, keeping depth > 200 verbatim.
  - `stash bad id`: `get("../x")` throws without fs access
  - `sweep`: a file with mtime 2 days old is removed
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `feat: output shaping (trim, cap, stash)`.

### Task 7: Runs, approval gate, audit

**Files:**
- Create: `src/gate/audit.ts`, `src/runs.ts`, `test/runs.test.ts`

**Interfaces:**
- Consumes: `Executor`/`DenoExecutor` (Task 2), `Upstreams` (Task 4), `Catalog.resolve/logCall/recordKeySizes/dropKeys` (Task 5), `Stash`/`toScriptValue`/`trim`/`cap`/`keySizes` (Task 6).
- Produces `appendAudit(e: {run_id; server; tool; args: unknown; decision: "approved" | "denied"; via: "elicitation" | "approve" | "expired"}): void`. It appends a JSONL line to `paths().auditLog` (0600) with `ts` added and `args` truncated to 500 chars.
- Produces:
  ```ts
  export type Outcome =
    | { status: "completed"; result: unknown; logs: string[]; stashed?: string }
    | { status: "error"; error: string; logs: string[] }
    | { status: "paused"; run_id: string; pending: { server: string; tool: string; args: unknown } };
  export class Runs {
    constructor(d: { executor: Executor; catalog: Catalog; upstreams: Upstreams; stash: Stash; elicit?: (msg: string) => Promise<boolean>; recipePrelude?: (code: string) => string; pauseTtlMs?: number /* 900_000 */ });
    execute(code: string, timeoutMs?: number): Promise<Outcome>;
    approve(runId: string, decision: "yes" | "no"): Promise<Outcome>;  // unknown/expired id → throws Error("unknown or expired run <id>")
  }
  ```
  How it works:
  - The executor is called with fns built from `catalog` for every `ns.ident`, plus `stash.get`.
  - A read fn calls upstream, then `toScriptValue` → `trim(dropKeys)` → `logCall` + `recordKeySizes`.
  - A write fn acquires the run's write mutex (a promise chain). It then tries `elicit` if provided. A throw from `elicit` falls through to pause. Otherwise it registers a pending approval: it sets `clock.paused = true` and emits the pause, which resolves the current `execute`/`approve` waiter with `paused`. It then awaits the decision.
  - Yes → call upstream. No → throw `ApprovalDenied: <ns.ident> denied by user`. Both paths write `appendAudit`.
  - After `pauseTtlMs` the run is aborted (`signal`), audited as `expired`, and dropped.
  - `execute`/`approve` each await `Promise.race([runCompletion, nextPause])`. The completion result is passed through `cap`, and timeouts are clamped to `MAX_TIMEOUT_MS`.

- [ ] **Step 1:** Write tests against the fixture server (stdio). Set `FIXTURE_LOG` to count executions.
  - `read runs freely`: `return await fx.get_item({id:"7"})` → completed, `result.name === "item 7"`, with `empty` and `tags` trimmed away
  - `write pauses, yes executes`: `await fx.delete_item({id:"1"}); return "done"` → `paused` with `pending.tool === "delete_item"`, and `FIXTURE_LOG` has no `delete_item` line. `approve(run_id,"yes")` → completed `"done"`, `FIXTURE_LOG` has exactly 1 `delete_item`, and the audit log has 1 line with `decision:"approved", via:"approve"`.
  - `no throws ApprovalDenied`: script catches and returns `e.message` → completed with a message containing `ApprovalDenied`, and the fixture log has 0 `delete_item`
  - `unknown tool is write`: `fx.make_thing({})` pauses
  - `elicitation path`: with `elicit: async () => true` → completed without pause, audit `via:"elicitation"`. With `elicit: async () => { throw new Error("x") }` → paused (fallback).
  - `writes serialised`: `await Promise.all([fx.delete_item({id:"1"}), fx.delete_item({id:"2"})])` → one pause, then after yes another pause, then after yes completed (never two pendings)
  - `paused clock`: `timeoutMs: 500`, a pause held 1 000 ms before approve → completes (not timeout)
  - `pause expiry`: `pauseTtlMs: 300` → after 500 ms `approve` throws `/unknown or expired/`, and the audit has `via:"expired"`
  - `approve twice`: the second `approve` on the same completed run throws `/unknown or expired/`, and the fixture log still has 1 `delete_item`
  - `result capped`: returning `"x".repeat(20000)` → `stashed` is set, and a second `execute("return await stash.get('<id>')")` returns the length 20 000
  - `upstream failure surfaces`: `fx.fail_tool({})` caught → `"nope"`, and `fx.crash` → the message starts with `fx: `
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `feat: run orchestration with approval gate, pause/approve, audit log`.

### Task 8: MCP server (five tools) and `serve`

**Files:**
- Create: `src/instructions.ts`, `src/server.ts`, `src/cli.ts` (serve only for now), `test/server.test.ts`

**Interfaces:**
- Produces `buildInstructions(top: string[]): string`. It is this exact header followed by `top` lines, which are dropped from the end until total ≤ 3 500 chars:
  ```
  codebridge: call tools of many MCP servers by writing code.
  1. search(query) → find tools/recipes as "ns.tool — summary [read|write|recipe]".
  2. describe(names) → TypeScript signatures for the ones you need.
  3. execute(code) → async function body; call tools as await ns.tool({...}); return only what you need. Results over ~4k tokens are stashed: stash.get(id).
  4. Writes pause for approval: if execute returns status "paused", call approve(run_id, "yes"|"no") only after the user agrees.
  5. save_recipe(name, code, description) stores a working script; call it later as recipes.name(args).
  Frequently used:
  ```
- Produces `createServer(d: { runs: Runs; catalog: Catalog; saveRecipe: (n,c,desc) => string }): McpServer`. It registers `search({query: string, limit?: number})`, `describe({names: string[]})`, `execute({code: string, timeout_ms?: number})`, `approve({run_id: string, decision: "yes"|"no"})` and `save_recipe({name, code, description})`. Each returns one compact JSON text part. Tool descriptions stay ≤ 200 chars each. `elicit` is wired as follows: when `server.server.getClientCapabilities()?.elicitation` is present, call `server.server.elicitInput({message, requestedSchema:{type:"object",properties:{}}})`, and only `action === "accept"` means yes.
- `src/cli.ts` with no args: load servers → `Upstreams`, `Catalog`, `Stash`, `DenoExecutor`, `Runs` → `createServer` with instructions from `catalog.get("instructions_top")`, which is split on newlines → `StdioServerTransport`.

- [ ] **Step 1:** Write tests using the SDK `InMemoryTransport.createLinkedPair()` and an SDK `Client`:
  - `lists exactly five tools` named `search, describe, execute, approve, save_recipe`
  - `footprint`: `JSON.stringify(listTools().tools).length + instructions.length` ≤ 4 000 chars (≈ 1 000 tokens, G2)
  - `instructions ≤ 3500`: `buildInstructions` with 500 long lines → length ≤ 3 500, and it starts with the header
  - `search → describe → execute` end to end against the fixture → `"item 7"`
  - `execute paused → approve` via tool calls (client without elicitation capability)
  - `elicitation accepted`: a client declaring `capabilities:{elicitation:{}}` with a handler returning `{action:"accept"}` → `execute` completes without a pause, and `decline` → script sees `ApprovalDenied`
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Smoke-test the real stdio entry: run `printf '<initialize + tools/list NDJSON>' | node src/cli.ts` with `XDG_*` pointing at a temp home → output contains the five tool names. Paste it.
- [ ] **Step 6:** Commit: `feat: MCP server exposing search/describe/execute/approve/save_recipe`.

### Task 9: Recipes

**Files:**
- Create: `src/recipes.ts`, `test/recipes.test.ts`
- Modify: `src/server.ts`, `src/cli.ts` (wire `saveRecipe`, `recipePrelude`)

**Interfaces:**
- Produces:
  ```ts
  export function recipeCalls(code: string): string[]             // "ns.ident" matches of /\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s*\(/g, excluding recipes./stash./console./Math./JSON./Promise./Object./Array.
  export function saveRecipe(name: string, code: string, description: string, catalog: Catalog): string  // name /^[a-z][a-z0-9_]{0,63}$/, else throws; every recipeCalls entry must resolve, else throws listing the missing ones; writes file; upsertRecipe; returns "saved recipes.<name>"
  export function recipePrelude(code: string, catalog: Catalog): string  // "const recipes = { name: async (args) => {<body>}, ... };" for ok recipes referenced in code; always defines `recipes` (possibly {})
  export function checkRecipes(catalog: Catalog): { name: string; reason: string }[]  // per recipe: missing tools, else `deno check --no-config --no-remote` on a temp file = catalog.checkDeclarations() + "async function __r(args: any) {\n<body>\n}"; failures → upsertRecipe(status "broken", reason = first 300 chars of output)
  ```

- [ ] **Step 1:** Write tests:
  - a bad name throws, and code calling `fx.nope()` throws `/fx.nope/`
  - after saving `get7` (`return await fx.get_item({id: args.id})`), `search("get7")` shows `recipes.get7 — … [recipe]`, and `runs.execute("return await recipes.get7({id:'7'})")` → `"item 7"`
  - `checkRecipes` flags a recipe calling `fx.get_item({wrong: 1})` as broken (type error, missing `id`), and it then disappears from `search`
  - a recipe referencing a tool removed by re-sync → broken with reason `missing fx.slow`
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `feat: recipes (save, inline in sandbox, deno check)`.

### Task 10: Refresh, rules, systemd timer

**Files:**
- Create: `src/refresh.ts`, `systemd/codebridge-refresh.service`, `systemd/codebridge-refresh.timer`, `test/refresh.test.ts`
- Modify: `src/cli.ts` (`refresh`, `rules list|accept <id>|reject <id>`)

**Interfaces:**
- Produces `refresh(d: {servers: Record<string, ServerEntry>; catalog: Catalog; upstreams: Upstreams; stash: Stash}): Promise<Report>` where `Report = {up: string[]; stale: string[]; unsupported: string[]; failed: string[]; changed: string[]; errors: string[]; broken: string[]; proposed: number}`. Its steps:
  1. For each enabled server not marked `unsupported`, `checkNamespace`, then `listTools` → `syncServer` → `markServer("up")`. On error → `markServer("stale", msg)` and keep its rows.
  2. `checkRecipes`.
  3. Usage: `UPDATE tools SET usage = Σ exp(-age_days/7)` from `calls`, then `set("instructions_top", <top 25 by usage, lines from search format>)`.
  4. `proposeRules()`.
  5. Delete `calls` older than 30 days and run `stash.sweep()`.
  6. `set("last_report", JSON)`.
- The `codebridge rules` subcommands are `list` (prints `id server.tool key status`), `accept <id>` and `reject <id>`. `dropKeys` returns only accepted rules.
- systemd: the service is `Type=oneshot`, `ExecStart=%h/.local/bin/codebridge refresh`. The timer is `OnCalendar=hourly`, `Persistent=true`, `RandomizedDelaySec=120`.

- [ ] **Step 1:** Write tests:
  - `refresh` against the fixture + one bad server → `up:["fx"]`, `stale:["bad"]`, and a pre-existing `bad` tool row is kept
  - after 6 `logCall`/`recordKeySizes` with `blob` averaging 3 000 bytes, `refresh` → `proposed ≥ 1`, and `dropKeys` is still `[]` until `setRule(id,"accepted")`, after which it is `["blob"]`
  - `instructions_top` lists the most-called tool first and `buildInstructions(...)` ≤ 3 500
  - an old `calls` row (40 days) is deleted
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Install the CLI link and timer. These touch only the user's own `~/.local/bin` and `~/.config/systemd/user`, not Claude Code config. `ln -sf $PWD/src/cli.ts ~/.local/bin/codebridge && chmod +x src/cli.ts && cp systemd/* ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now codebridge-refresh.timer && systemctl --user list-timers codebridge-refresh.timer`. Expected: the timer is listed with a next run time.
- [ ] **Step 6:** Commit: `feat: refresh job (catalog, recipes, ranking, rule proposals) + systemd timer`.

### Task 11: `import`, `login`, `verify`, `status`

**Files:**
- Create: `src/commands.ts`, `test/commands.test.ts`, `README.md`
- Modify: `src/cli.ts`

**Interfaces:**
- Produces:
  ```ts
  export function importServers(claudeJson = join(homedir(), ".claude.json")): { added: string[]; skipped: string[] }  // reads top-level mcpServers only; skips "codebridge" and names already in servers.json; never writes claudeJson (open read-only)
  export async function verify(name: string, d): Promise<{ ok: boolean; lines: string[] }>  // direct listTools count vs catalog count for that server; one read call: first read tool whose inputSchema has no required props, called with {}; none → "no argument-free read tool; skipped"
  export function status(catalog: Catalog, servers): string  // per server: name, type, status, reason; stale/unsupported/failed get "keep the direct entry"; last report summary; pending rules count; broken recipes; fixed line: "Note: approval relies on Claude Code's permission prompt for approve; in auto mode or if mcp__codebridge__approve is allow-listed, writes may run without a prompt."
  ```
  The CLI `login <server>` calls `login()` and writes `unsupported` with its reason via `markServer`.

- [ ] **Step 1:** Write tests:
  - `importServers` on a temp `claude.json` with `{mcpServers:{a:{command:"x",env:{K:"secret"}}, codebridge:{command:"y"}}}` → `added:["a"]`, `servers.json` mode 0600, `claude.json` bytes and mtime unchanged
  - `status` output never contains the secret value `secret` or any header value, and includes `keep the direct entry` for a stale server and the auto-mode note
  - `verify fx` → ok, with lines showing `9 = 9` and a successful read
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement and write `README.md` (install, `claude mcp add` line, commands, the accepted approval risk). **Step 4:** Run → PASS.
- [ ] **Step 5:** Run the full suite with `npm test` and paste the summary.
- [ ] **Step 6:** Commit: `feat: import, login, verify, status commands`.

### Task 12: Live trial with real servers (read-only)

- [ ] **Step 1:** Run `codebridge import`, then `codebridge refresh`, then `codebridge status`. Paste the output with secrets redacted. The status code already redacts them, so this is a check.
- [ ] **Step 2:** For each `http`/`sse` server that needs OAuth, run `codebridge login <server>`. **The browser step needs the user**, so hand them the command list to run with `! codebridge login <name>`.
- [ ] **Step 3:** claude.ai connectors: find their endpoint URLs read-only (`claude mcp list` output). If URLs are available, add them to `servers.json` and attempt `login`. A refused DCR leaves the server `unsupported` with its reason in `status`. If no URL is discoverable, record the connector as `unsupported: "endpoint not discoverable"`.
- [ ] **Step 4:** Run `codebridge verify <server>` for each up server. Paste the results.
- [ ] **Step 5:** Tell the user the exact trial command and stop. Do not run it:
  `claude mcp add --scope user codebridge -- /home/orneyfish/.local/bin/codebridge`
- [ ] **Step 6:** Commit any README/status fixes found during the trial.

### Task 13: Benchmark (design §5.9)

**Files:**
- Create: `bench/tasks.json`, `bench/run.ts`, `bench/README.md`

**Interfaces:**
- `bench/tasks.json` holds `{primary: Task[], recipeTraining: Task[]}`, where `Task = {id, prompt, servers: string[], expect: string[]}`. `expect` holds substrings that must appear in the final answer. There are 6 primary tasks across vercel, codegraph and mempalace, and 3 disjoint training tasks. All are read-only (list/get/search). Their `expect` values are gathered from direct read-only calls when the tasks are written.
- `node bench/run.ts [--with-recipes]` works as follows:
  - Build two temp MCP configs (mode 0600, in `bench/out/`, deleted at the end): direct (the task's servers copied from `~/.claude.json`, read-only) and bridge (`codebridge` only).
  - Run each task with `claude -p <prompt> --output-format stream-json --verbose --strict-mcp-config --mcp-config <file>`.
  - Sum `usage` (input + cache_creation + cache_read + output) from the result event, and count `tool_use` events and wall time.
  - Check `expect`.
  - Print a table and `PASS` when total tokens drop ≥ 30% and the success count is equal.
  - Before measuring, run `codebridge refresh`, and for the primary run check that recipe count = 0. Fail otherwise. With `--with-recipes`, first run the training tasks with recipes allowed, then report separately.

- [ ] **Step 1: STOP and ask the user.** Headless `claude -p` needs permission to call MCP tools, which means either a per-invocation `--allowedTools` flag or a permission mode. The hard rule forbids allow-listing codebridge tools. Propose `--allowedTools` limited to `mcp__codebridge__search,describe,execute` (never `approve`) plus the direct servers' read tools, passed only as a CLI flag (no config change), and wait for a yes. A `paused` outcome during the bench counts as task failure, and no write ever executes.
- [ ] **Step 2:** Write `bench/run.ts` with a pure `summarize(events): {tokens, toolCalls}` and a self-check test (`test/bench.test.ts`) over a recorded stream-json sample.
- [ ] **Step 3:** Run `node bench/run.ts`. Paste the table. If it is below 30%, report the honest number and the biggest per-task cost, and don't tune the tasks to pass.
- [ ] **Step 4:** Run `node bench/run.ts --with-recipes` and paste its separate table.
- [ ] **Step 5:** Commit: `feat: token benchmark (direct vs codebridge)`.

---

## Self-review notes

- Coverage: §5.2 → Tasks 8–9. §5.3 → 3, 4, 4b, 11, 12. §5.4 → 2. §5.5 → 5 (classify), 7, 8 (elicitation). §5.6 → 6, 10 (rules). §5.7 → 10, with shared state in 5's concurrency test. §5.8 → 11, 12. §5.9 → 13. G2 footprint → Task 8 test.
- Not in v1, per design: upstream resources/prompts, a type-check pass on `execute`, and property-access tracking (simplified as the design allows).

---

## Change requested by the user during execution (2026-11-20)

> "Don't guess the tool usage, may be a small call to the haiku models or smaller models available should let select instead of wrong guess."

This replaces the name heuristic in design §5.5. The new classification order is: config override, then MCP annotations, then **Haiku's verdict**, then **write**.
- `classify()` drops the name-prefix rule and returns `undefined` when neither an override nor an annotation decides.
- The catalog stores `access_src` (`override|annotation|model|default`). A tool without a verdict is `write` (`default`). A model verdict is kept while the tool's hash is unchanged.
- `src/gate/model-classify.ts` provides `classifyWithModel(tools, ask = askHaiku)`. It sends batches of ≤ 40 tools (`id`, name, description, TS signature) to `claude -p --model haiku --strict-mcp-config --tools "" --no-session-persistence --output-format json`, which was verified working in this session (~3 s, `claude-haiku-5-5`). The reply is a JSON object of `id → "read"|"write"`. Anything missing or invalid, and any failure, leaves the tool at `write`. The prompt says "unsure → write". Only tool metadata is sent, never arguments, results or secrets.
- `refresh` (Task 10) classifies the catalog's `unclassified()` tools after syncing and reports failures in `errors`.

## Changes approved by the user after benchmark run 2 (2026-11-20)

- `search` appends the TypeScript signatures of its top 3 matches, which saves a `describe` round trip in the common case. `describe` stays available for other tools.
- Trimming keeps empty arrays (design §5.6 said to drop all empty fields). With them dropped, a search that found nothing turned `items: []` into `undefined`, and scripts that called `.map` on it crashed.
- Earlier fix found by the benchmark: the five tools carry `_meta["anthropic/alwaysLoad"] = true`, so Claude Code doesn't defer them behind tool search (design G2).
- Learned result shapes (approved after run 3): every successful read call stores a compact type inferred from the trimmed result (`shapeOf`: keys and value types only; data-like keys collapse to `Record<string, unknown>`; ≤ 800 chars). It is stored only for tools without an `outputSchema`. A shorter shape never replaces a longer one, and the shape resets when the tool's hash changes. `describe` and `search` show it as the return type, and `checkDeclarations` keeps `any`. `openDb` adds the column to existing catalogs.

## Benchmark findings (2026-11-20, runs 5–8)

Pass bar (design §5.9): ≥ 30 % fewer total tokens with equal task success. **Current status: not met on the held-out set once the measurement bias below is removed.**

| run | set | reported saving | notes |
|---|---|---|---|
| 5 | held-out (9) | 32.8 % | first task inflated (greenfield, below) → ≈ 31 % |
| 6 | tuned (10) | 22.2 % no recipes / 30.4 % with recipes | inflated → ≈ 20 % / ≈ 29 % |
| 7a, 7b | held-out | 30.8 %, 37.0 % | inflated → ≈ 29 %, ≈ 36 % |
| 8a, 8b | held-out, bias fixed | 17.3 %, 21.5 % | direct h-cf-whoami failed (Claude Code's own cloudflare connection unauthenticated); excluding it 23.4 %, 27.5 % |

Findings:
- **One task carries the saving.** Without h-vc-gpt-1m (direct wanders through 6–9 calls, 140–187 k tokens) the held-out saving is 7–10 % in runs 5/7 and ≈ 0 % in run 8. codebridge wins clearly on large catalogs (vercel: 24–33 % per task) and loses 1–8 k tokens per task on small servers (codegraph, cloudflare, mempalace).
- **Variance is low at equal call counts** (< 4 % per task across runs); the swings are an extra tool call.
- **Extra calls on first use of a tool:** with a fresh catalog every return type is `Promise<unknown>`; Vercel wraps data as `{ result: {...} }`, the model guesses `r.domains`, and sometimes crashes and probes (h-vc-domains 3 calls in 1 of 2 reruns). Learned shapes remove this after the first successful call, so the bench measures each tool's worst case.
- **Measurement bias (fixed in 1aa6072):** an empty bench cwd made the Vercel plugin's SessionStart hook inject ≈ 10.5 k tokens of "greenfield" context into the first session of each run (always task 1, direct), inflating direct totals. The bench now seeds the work dir.
- **Lapsed logins invalidated a run (fixed in 11f7319, 1aa6072):** the Vercel login only requested `openid` and got a 1 h token with no refresh token. Login now adds `offline_access` when the auth server supports it; the bridge marks unreachable servers `stale`, and the bench refuses to start or stops mid-run when a needed server is not up.
- **Recipes:** training saved find_symbol_lines, find_symbol_usages, gateway_model_info; with recipes the tuned set gained ≈ 8 points but one task (cg-brightness) got worse.

Open:
- Re-authenticate Claude Code's cloudflare connection and rerun the held-out set for clean numbers (`--keep-transcripts`).
- Decide scope: front only large-catalog servers (e.g. vercel) through codebridge and keep small servers direct.
- Not yet observed: an automatic token refresh after the 1 h expiry.
