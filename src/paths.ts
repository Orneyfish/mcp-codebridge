import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function paths() {
  const configDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "codebridge");
  const dataDir = join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "codebridge");
  return {
    configDir,
    dataDir,
    serversFile: join(configDir, "servers.json"),
    catalogDb: join(dataDir, "catalog.db"),
    tokensDir: join(dataDir, "tokens"),
    recipesDir: join(dataDir, "recipes"),
    stashDir: join(dataDir, "stash"),
    auditLog: join(dataDir, "audit.log"),
  };
}

export function writeSecretFile(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(dirname(file), 0o700);
  writeFileSync(file, data, { mode: 0o600 });
  chmodSync(file, 0o600); // mode option only applies on create
}
