import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.ts";

export class Stash {
  private dir: string;
  constructor(dir = paths().stashDir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  put(v: unknown): string {
    const id = randomBytes(4).toString("hex");
    writeFileSync(join(this.dir, `${id}.json`), JSON.stringify(v), { mode: 0o600 });
    return id;
  }
  get(id: string): unknown {
    try {
      if (!/^[0-9a-f]{8}$/.test(id)) throw 0;
      return JSON.parse(readFileSync(join(this.dir, `${id}.json`), "utf8"));
    } catch {
      throw new Error(`stash ${JSON.stringify(id)} not found or expired`);
    }
  }
  sweep(maxAgeMs = 86_400_000): number {
    let n = 0;
    for (const f of readdirSync(this.dir)) {
      const p = join(this.dir, f);
      if (Date.now() - statSync(p).mtimeMs > maxAgeMs) { unlinkSync(p); n++; }
    }
    return n;
  }
}
