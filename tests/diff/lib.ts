import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Result = { isError: boolean; text: string; data: unknown };
export type Side = {
  name: "SOURCE" | "NEW";
  call(tool: string, args?: Record<string, unknown>): Promise<Result>;
  rpc(body: unknown): Promise<unknown>;
  http(path: string, init?: RequestInit): Promise<Response>;
  base: string;
};

export function makeSide(name: Side["name"], base: string): Side {
  const post = (body: unknown) =>
    fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  let id = 0;
  return {
    name, base,
    async rpc(body) { return (await post(body)).json(); },
    http: (path, init) => fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(60_000) }),
    async call(tool, args = {}) {
      const j = (await (await post({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: tool, arguments: args } })).json()) as any;
      if (j.error) return { isError: true, text: `RPC ${j.error.code}: ${j.error.message}`, data: null };
      const r = j.result;
      return { isError: Boolean(r.isError), text: r.content?.[0]?.text ?? "", data: r.structuredContent ?? null };
    },
  };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
const ORIGIN = /https?:\/\/127\.0\.0\.1:\d+/g;
/** Prose that CloseSEO words independently; the codes and structured values around it are still compared. */
const PROSE = new Set(["message", "scopeNote"]);
const VOLATILE = new Set(["fetchedAt", "createdAt", "updatedAt", "startedAt", "completedAt", "lastCheckedAt", "checkedAt", "nextRunAt", "runId", "token"]);

export function normalize(v: unknown): unknown {
  if (typeof v === "string") return v.replace(UUID, "<id>").replace(TS, "<ts>").replace(ORIGIN, "<origin>").replace(/\/s\/[A-Za-z0-9_-]{20,}/g, "/s/<token>");
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as object)) o[k] = (VOLATILE.has(k) || PROSE.has(k)) && x !== null ? (PROSE.has(k) ? "<prose>" : "<volatile>") : normalize(x);
    return o;
  }
  return v;
}

export type Diff = { path: string; source: unknown; new: unknown };
export function deepDiff(a: unknown, b: unknown, path = "$"): Diff[] {
  if (a === b) return [];
  const ta = Array.isArray(a) ? "array" : a === null ? "null" : typeof a;
  const tb = Array.isArray(b) ? "array" : b === null ? "null" : typeof b;
  if (ta !== tb) return [{ path, source: a, new: b }];
  if (ta === "array") {
    const out: Diff[] = [];
    const x = a as unknown[], y = b as unknown[];
    if (x.length !== y.length) out.push({ path: `${path}.length`, source: x.length, new: y.length });
    for (let i = 0; i < Math.min(x.length, y.length); i++) out.push(...deepDiff(x[i], y[i], `${path}[${i}]`));
    return out;
  }
  if (ta === "object") {
    const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
    const out: Diff[] = [];
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (!(k in x)) out.push({ path: `${path}.${k}`, source: undefined, new: y[k] });
      else if (!(k in y)) out.push({ path: `${path}.${k}`, source: x[k], new: undefined });
      else out.push(...deepDiff(x[k], y[k], `${path}.${k}`));
    }
    return out;
  }
  return [{ path, source: a, new: b }];
}

/** Structure-only comparison: same keys and value types, ignoring values (for nondeterministic output). */
export function shapeOf(v: unknown): unknown {
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0])] : [];
  if (v === null) return "null";
  if (typeof v === "object") return Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, shapeOf(x)]));
  return typeof v;
}

export async function bootNew(env: Record<string, string>): Promise<{ base: string; stop(): Promise<void>; proc: ChildProcess }> {
  const port = 21000 + Math.floor(Math.random() * 15000);
  const dir = mkdtempSync(join(tmpdir(), "closeseo-diff-"));
  const proc = spawn(process.execPath, ["src/server.ts"], { env: { ...process.env, PORT: String(port), DATABASE_PATH: join(dir, "d.db"), DISABLE_SCHEDULER: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout!.on("data", (d) => (out += d)); proc.stderr!.on("data", (d) => (out += d));
  const end = Date.now() + 15000;
  while (!out.includes("listening")) { if (Date.now() > end) throw new Error("NEW server failed to start: " + out); await new Promise((r) => setTimeout(r, 50)); }
  return { base: `http://127.0.0.1:${port}`, proc, stop: () => new Promise((r) => { proc.once("exit", () => r()); proc.kill("SIGTERM"); }) };
}
