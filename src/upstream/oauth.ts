import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { ServerEntry } from "../config.ts";
import { paths, writeSecretFile } from "../paths.ts";

// Fixed port so the redirect_uri registered via DCR stays valid across logins.
export const CALLBACK_URL = "http://127.0.0.1:47823/callback";

export class NeedsLogin extends Error {}

type State = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string };

export class FileOAuthProvider implements OAuthClientProvider {
  private server: string;
  private opts: { interactive: boolean; clientId?: string; onRedirect?: (u: URL) => void };
  constructor(server: string, opts: { interactive: boolean; clientId?: string; onRedirect?: (u: URL) => void }) {
    this.server = server;
    this.opts = opts;
  }
  private get file() { return join(paths().tokensDir, `${this.server}.json`); }
  private read(): State { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {}; }
  private write(patch: Partial<State>) { writeSecretFile(this.file, JSON.stringify({ ...this.read(), ...patch })); }

  get redirectUrl() { return CALLBACK_URL; }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "codebridge", redirect_uris: [CALLBACK_URL], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  clientInformation() { return this.opts.clientId ? { client_id: this.opts.clientId } : this.read().client; }
  saveClientInformation(client: OAuthClientInformationMixed) { this.write({ client }); }
  tokens() { return this.read().tokens; }
  saveTokens(tokens: OAuthTokens) { this.write({ tokens }); }
  saveCodeVerifier(verifier: string) { this.write({ verifier }); }
  codeVerifier() {
    const v = this.read().verifier;
    if (!v) throw new Error(`${this.server}: no PKCE verifier saved`);
    return v;
  }
  private asScopes: string[] = [];
  saveDiscoveryState(state: { authorizationServerMetadata?: { scopes_supported?: string[] } }) {
    this.asScopes = state.authorizationServerMetadata?.scopes_supported ?? [];
  }
  redirectToAuthorization(url: URL) {
    if (!this.opts.interactive || !this.opts.onRedirect) throw new NeedsLogin(`${this.server}: run "codebridge login ${this.server}"`);
    // The SDK requests the resource's scopes (Vercel: just "openid"), which yields a 1 h token with no refresh token.
    const scope = url.searchParams.get("scope") ?? "";
    if (this.asScopes.includes("offline_access") && !scope.split(" ").includes("offline_access")) {
      url.searchParams.set("scope", [scope, "offline_access"].filter(Boolean).join(" "));
      if (!url.searchParams.has("prompt")) url.searchParams.set("prompt", "consent");
    }
    this.opts.onRedirect(url);
  }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    const s = this.read();
    if (scope === "all" || scope === "client") delete s.client;
    if (scope === "all" || scope === "tokens") delete s.tokens;
    if (scope === "all" || scope === "verifier") delete s.verifier;
    writeSecretFile(this.file, JSON.stringify(s));
  }
}

const UNSUPPORTED = /dynamic client registration|registration_endpoint|does not support/i;

export async function login(server: string, entry: ServerEntry): Promise<{ ok: true } | { unsupported: string }> {
  if (!("url" in entry)) throw new Error(`${server}: login applies to http/sse servers only`);
  let authUrl: URL | undefined;
  const provider = new FileOAuthProvider(server, { interactive: true, clientId: entry.oauth?.clientId, onRedirect: (u) => { authUrl = u; } });
  provider.invalidateCredentials("tokens");

  let gotCode!: (c: string) => void, failed!: (e: Error) => void;
  const code = new Promise<string>((res, rej) => { gotCode = res; failed = rej; });
  const cb = createServer((req, res) => {
    const u = new URL(req.url!, CALLBACK_URL);
    if (u.pathname !== "/callback") { res.statusCode = 404; return res.end(); }
    const c = u.searchParams.get("code");
    res.end(c ? "codebridge: signed in. You can close this tab." : "codebridge: sign-in failed.");
    c ? gotCode(c) : failed(new Error(`${server}: authorization failed: ${u.searchParams.get("error") ?? "no code"}`));
  });
  await new Promise<void>((res, rej) => cb.once("error", rej).listen(47823, "127.0.0.1", res));
  const timer = setTimeout(() => failed(new Error(`${server}: login timed out after 5 minutes`)), 300_000);
  try {
    const r = await auth(provider, { serverUrl: entry.url });
    if (r === "REDIRECT") {
      console.error(`Open this URL to sign in to ${server}:\n${authUrl}`);
      spawn("xdg-open", [String(authUrl)], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
      await auth(provider, { serverUrl: entry.url, authorizationCode: await code });
    }
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (UNSUPPORTED.test(msg)) return { unsupported: msg };
    throw e;
  } finally {
    clearTimeout(timer);
    cb.close();
  }
}
