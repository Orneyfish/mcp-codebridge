// Same shape as @cloudflare/codemode's Executor (dropped: it doesn't load in Node, see docs/spike-codemode.md).
export interface ExecuteResult { result: unknown; error?: string; logs?: string[] }
export type Fns = Record<string, (args: unknown) => Promise<unknown>>;
export interface ExecuteOptions { timeoutMs?: number; clock?: { paused: boolean }; prelude?: string; signal?: AbortSignal }
export interface Executor { execute(code: string, fns: Fns, options?: ExecuteOptions): Promise<ExecuteResult> }
