import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { statSync } from "node:fs";
import { join } from "node:path";
import { tmpHome } from "./helpers.ts";
import { paths } from "../src/paths.ts";
import { FileOAuthProvider, NeedsLogin, login } from "../src/upstream/oauth.ts";

test("token file 0600 and round-trip", async () => {
  tmpHome();
  await new FileOAuthProvider("s", { interactive: false }).saveTokens({ access_token: "a", token_type: "bearer" });
  assert.deepEqual(await new FileOAuthProvider("s", { interactive: false }).tokens(), { access_token: "a", token_type: "bearer" });
  assert.equal(statSync(join(paths().tokensDir, "s.json")).mode & 0o777, 0o600);
});

test("clientId override skips DCR", async () => {
  tmpHome();
  assert.deepEqual(await new FileOAuthProvider("s", { interactive: false, clientId: "cid" }).clientInformation(), { client_id: "cid" });
});

test("non-interactive redirect throws NeedsLogin", async () => {
  tmpHome();
  const p = new FileOAuthProvider("s", { interactive: false });
  assert.throws(() => p.redirectToAuthorization(new URL("https://auth/x")), (e: Error) => e instanceof NeedsLogin && /codebridge login s/.test(e.message));
});

test("DCR refused → unsupported, tokens never logged", async () => {
  tmpHome();
  await new FileOAuthProvider("g", { interactive: false }).saveTokens({ access_token: "SECRET-TOKEN-VALUE", token_type: "bearer" });
  const srv = createServer((req, res) => {
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    res.setHeader("content-type", "application/json");
    if (req.url!.startsWith("/.well-known/oauth-protected-resource")) return res.end(JSON.stringify({ resource: base + "/mcp", authorization_servers: [base] }));
    if (req.url!.startsWith("/.well-known/oauth-authorization-server")) return res.end(JSON.stringify({
      issuer: base, authorization_endpoint: base + "/authorize", token_endpoint: base + "/token",
      response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
    }));
    res.statusCode = req.url === "/mcp" ? 401 : 404;
    res.end("{}");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const out: string[] = [];
  const orig = { log: console.log, error: console.error };
  console.log = console.error = (...a: unknown[]) => { out.push(a.join(" ")); };
  try {
    const r = await login("g", { type: "http", url: `http://127.0.0.1:${(srv.address() as any).port}/mcp` });
    assert.ok("unsupported" in r && r.unsupported.length > 0, JSON.stringify(r));
  } finally {
    Object.assign(console, orig);
    srv.close();
  }
  assert.ok(!out.join("\n").includes("SECRET-TOKEN-VALUE"));
});
