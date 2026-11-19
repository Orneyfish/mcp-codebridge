# Spike: @cloudflare/codemode in Node 26 (2026-11-20)

Installed `@cloudflare/codemode@0.5.6` (with `@modelcontextprotocol/sdk@1.32.2`, `zod@4.6.7`) in a scratch dir, Node v26.13.1.

- `import("@cloudflare/codemode")` → `Only URLs with a scheme in: file, data, and node are supported ... Received protocol 'cloudflare:'` (main entry imports `cloudflare:workers`).
- `import("@cloudflare/codemode/mcp")` → `Cannot find package '@cfworker/json-schema'` (would need an extra dependency).

Decision (design §7): drop the dependency. `src/executor.ts` mirrors its `Executor` shape:
`execute(code, fns, options?) → Promise<{ result, error?, logs? }>`. JSON Schema → TS conversion is in-repo (`src/catalog/tsdecl.ts`).
