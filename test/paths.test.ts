import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpHome } from "./helpers.ts";
import { paths, writeSecretFile } from "../src/paths.ts";

test("paths honours XDG", () => {
  const root = tmpHome();
  assert.equal(paths().serversFile, join(root, "config/codebridge/servers.json"));
  assert.equal(paths().catalogDb, join(root, "data/codebridge/catalog.db"));
});

test("writeSecretFile modes", () => {
  const root = tmpHome();
  const f = join(root, "a/b/secret.json");
  writeSecretFile(f, "x");
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(f)).mode & 0o777, 0o700);
  const g = join(root, "c/old.json");
  mkdirSync(dirname(g), { recursive: true });
  writeFileSync(g, "y", { mode: 0o644 });
  writeSecretFile(g, "z");
  assert.equal(statSync(g).mode & 0o777, 0o600);
});
