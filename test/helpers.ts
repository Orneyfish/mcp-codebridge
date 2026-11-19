import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tmpHome(): string {
  const root = mkdtempSync(join(tmpdir(), "cb-test-"));
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_DATA_HOME = join(root, "data");
  return root;
}
