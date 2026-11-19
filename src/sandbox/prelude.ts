// Runs inside Deno. Talks to the parent with NDJSON: stdout = call/log/done, stdin = ret.
export const PRELUDE = String.raw`
const __enc = new TextEncoder();
function __send(m) {
  const b = __enc.encode(JSON.stringify(m) + "\n");
  for (let o = 0; o < b.length;) o += Deno.stdout.writeSync(b.subarray(o));
}
const __fmt = (a) => typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })();
for (const level of ["log", "info", "warn", "error", "debug"]) {
  console[level] = (...a) => __send({ t: "log", level, msg: a.map(__fmt).join(" ") });
}
const __pending = new Map();
let __nextId = 0;
function __call(fn, args) {
  const id = ++__nextId;
  return new Promise((resolve, reject) => {
    __pending.set(id, { resolve, reject });
    __send({ t: "call", id, fn, args: args === undefined ? null : args });
  });
}
(async () => {
  let buf = "";
  const dec = new TextDecoder();
  for await (const chunk of Deno.stdin.readable) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      const p = __pending.get(m.id);
      if (!p) continue;
      __pending.delete(m.id);
      m.ok ? p.resolve(m.value) : p.reject(new Error(m.error));
    }
  }
})();
function __namespace(ns) {
  return new Proxy({}, {
    get: (_, tool) => typeof tool === "string" && tool !== "then" ? (args) => __call(ns + "." + tool, args) : undefined,
  });
}
async function __run(main) {
  try {
    const r = await main();
    __send({ t: "done", ok: true, result: r === undefined ? null : r });
  } catch (e) {
    __send({ t: "done", ok: false, error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
  }
  Deno.exit(0);
}
`;
