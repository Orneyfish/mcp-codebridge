# codebridge

A local Code Mode MCP bridge for Claude Code. It connects to your MCP servers (stdio, Streamable HTTP, SSE, bearer or OAuth) and exposes only five tools:

| Tool | What it does |
|---|---|
| `search(query, limit?)` | Ranked one-liners: `ns.tool — summary [read|write|recipe]` |
| `describe(names[])` | TypeScript signatures for those tools/recipes |
| `execute(code, timeout_ms?)` | Runs an async JS/TS body in a locked-down Deno sandbox; `await ns.tool({...})` calls upstream tools; only the return value comes back (capped ~4k tokens, overflow → `stash.get(id)`) |
| `approve(run_id, "yes"|"no")` | Answers a paused write |
| `save_recipe(name, code, description)` | Saves a working script as `recipes.<name>(args)` |

Design: `docs/superpowers/specs/2026-11-20-codebridge-design.md`. Plan and change log: `docs/superpowers/plans/2026-11-20-codebridge.md`.

## Install

Requires Node ≥ 26 (runs the `.ts` sources directly), Deno 2.x and the `claude` CLI on `PATH`.

```sh
npm i
ln -sf "$PWD/src/cli.ts" ~/.local/bin/codebridge
cp systemd/codebridge-refresh.* ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now codebridge-refresh.timer
```

## Use

```sh
codebridge import            # copy user-level mcpServers from ~/.claude.json (read only) into ~/.config/codebridge/servers.json (0600)
codebridge login <server>    # OAuth browser sign-in for an http/sse server (loopback callback on 127.0.0.1:47823)
codebridge refresh           # tool catalog, read/write classification, recipe checks, usage ranking, trim-rule proposals
codebridge verify <server>   # compare tool counts and run one argument-free read call
codebridge status            # servers up/stale/unsupported, broken recipes, pending rules
codebridge rules list | accept <id> | reject <id>
```

Add it to Claude Code alongside your existing servers (codebridge never edits Claude Code config):

```sh
claude mcp add --scope user codebridge -- ~/.local/bin/codebridge
```

`servers.json` uses Claude Code's `mcpServers` shape. Per-server extras: `alias`, `disabled`, `timeoutMs`, `tools.<name>.access: "read"|"write"`, `oauth.clientId`. `${VAR}` values resolve from the environment at connect time.

## Safety

- **Sandbox:** one `deno run` per `execute`, with every permission denied (net, read, write, env, run, ffi, sys), a 256 MB heap, a 60 s default timeout (300 s cap), a 10 MiB stdout cap and at most 200 tool calls per run. Credentials never enter the sandbox.
- **Read/write classification** (no guessing by name): config override, then the server's MCP annotations, then a cached verdict from Claude Haiku. Refresh asks Haiku with tool names, descriptions and signatures only. If none of these decides, the tool counts as **write**.
- **Writes pause for your yes/no.** If Claude Code supports elicitation, you get a prompt. Otherwise `execute` returns `status: "paused"` and the run waits up to 15 min for `approve`. Every write decision is appended to `~/.local/share/codebridge/audit.log` (0600).
- **Accepted risk:** without elicitation, approval relies on Claude Code's permission prompt for `approve`. In auto mode, or if `mcp__codebridge__approve` is ever allow-listed, writes may run without a prompt. codebridge never adds itself to any allow-list.
- **Trim rules:** mechanical trimming drops empty fields and stashes base64. Per-tool key-drop rules are only *proposed* by refresh and apply after `codebridge rules accept`.

## Develop

```sh
npm test
```
