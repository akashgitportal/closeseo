import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeDfs } from "./support/fake-dataforseo.ts";
import { FAKE_KEY, until } from "./support/harness.ts";

const dir = mkdtempSync(join(tmpdir(), "closeseo-"));
const procs: ChildProcess[] = [];
after(() => { procs.forEach((p) => p.kill("SIGKILL")); rmSync(dir, { recursive: true, force: true }); });

function boot(env: Record<string, string>) {
  const p = spawn(process.execPath, ["src/server.ts"], { env: { ...process.env, DATABASE_PATH: join(dir, "t.db"), HOST: "127.0.0.1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  procs.push(p);
  let out = "";
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
  return { p, out: () => out, exited: new Promise<number | null>((r) => p.on("exit", (code) => r(code))) };
}
const port = () => 20000 + Math.floor(Math.random() * 20000);

test("real server process: boots, serves, persists across restarts, shuts down cleanly on SIGTERM", async () => {
  const dfs = await startFakeDfs();
  const PORT = String(port());
  const env = { PORT, DATAFORSEO_API_KEY: FAKE_KEY, DATAFORSEO_BASE_URL: dfs.url };
  try {
    const a = boot(env);
    await until(() => a.out().includes("listening"), 10000);
    const base = `http://127.0.0.1:${PORT}`;
    const mk = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_project", arguments: { name: "Persist", domain: "example.com" } } }) });
    const id = ((await mk.json()) as any).result.structuredContent.project.id;
    assert.match(id, /^[0-9a-f-]{36}$/);
    a.p.kill("SIGTERM");
    assert.equal(await a.exited, 0, "graceful exit code 0");
    assert.match(a.out(), /shutting down/);
    const b = boot(env);
    await until(() => b.out().includes("listening"), 10000);
    const list = (await (await fetch(`${base}/api/projects`)).json()) as any;
    assert.deepEqual(list.projects.map((p: any) => p.id), [id], "data survived the restart");
    assert.equal(((await (await fetch(`${base}/api/health`)).json()) as any).status, "ok");
    b.p.kill("SIGTERM"); await b.exited;
  } finally { await dfs.close(); }
});
test("bad configuration exits non-zero with a clear message", async () => {
  for (const [env, re] of [[{ AUTH_MODE: "hosted" }, /AUTH_MODE/], [{ AUTH_MODE: "api_key" }, /CLOSESEO_API_KEY/], [{ PORT: "99999" }, /PORT/]] as const) {
    const x = boot({ ...env, PORT: (env as any).PORT ?? String(port()) });
    const code = await x.exited;
    assert.notEqual(code, 0); assert.match(x.out(), re);
  }
});
test("port already in use fails fast instead of hanging", async () => {
  const PORT = String(port());
  const a = boot({ PORT });
  await until(() => a.out().includes("listening"), 10000);
  const b = boot({ PORT, DATABASE_PATH: join(dir, "other.db") });
  const code = await Promise.race([b.exited, new Promise<string>((r) => setTimeout(() => r("hung"), 8000))]);
  assert.notEqual(code, "hung"); assert.notEqual(code, 0);
  a.p.kill("SIGTERM"); await a.exited;
});
test("startup warns about an exposed unauthenticated admin and missing API key", async () => {
  const PORT = String(port());
  const a = boot({ PORT, HOST: "0.0.0.0", DATABASE_PATH: join(dir, "warn.db"), DATAFORSEO_API_KEY: "" });
  await until(() => a.out().includes("WARNING: local_noauth") && a.out().includes("DATAFORSEO_API_KEY is not set"), 10000);
  assert.match(a.out(), /DATAFORSEO_API_KEY is not set/); assert.match(a.out(), /WARNING: local_noauth on a non-loopback host/);
  a.p.kill("SIGTERM"); await a.exited;
});
