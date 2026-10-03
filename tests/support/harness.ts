import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createRequire } from "node:module";
import { createApp } from "../../src/app.ts";
import { loadConfig, type Config } from "../../src/config.ts";
import type { Ctx } from "../../src/ctx.ts";
import { openDb } from "../../src/db.ts";
import { DfsClient } from "../../src/dfs/client.ts";

const require = createRequire(import.meta.url);
const golden = require("../golden/mcp-tools-list.json") as { tools: { name: string; outputSchema?: object }[] };
const ajv = new Ajv2020.default({ strict: false });
addFormats.default(ajv);
const outValidators = new Map(golden.tools.filter((t) => t.outputSchema).map((t) => [t.name, ajv.compile(t.outputSchema!)]));

export const FAKE_KEY = Buffer.from("fake:fake").toString("base64");

export function makeCtx(over: { dfsUrl?: string; noKey?: boolean; [env: string]: string | boolean | undefined } = {}): Ctx {
  const { dfsUrl, noKey, ...env } = over;
  const config: Config = loadConfig({
    DATABASE_PATH: ":memory:", DISABLE_SCHEDULER: "1", ALLOW_PRIVATE_AUDIT_TARGETS: "1",
    DATAFORSEO_API_KEY: noKey ? "" : FAKE_KEY, DATAFORSEO_BASE_URL: (dfsUrl as string | undefined) ?? "http://127.0.0.1:1", ...(env as Record<string, string>),
  } as NodeJS.ProcessEnv);
  const db = openDb(":memory:");
  return { db, config, dfs: new DfsClient({ apiKey: config.dataforseoKey, baseUrl: config.dataforseoBaseUrl, timeoutMs: 5000, retryDelayMs: config.dfsRetryDelayMs }) };
}

export type Rpc = { content: { type: string; text: string }[]; isError?: boolean; structuredContent?: any; _meta?: any };

export function makeClient(ctx: Ctx) {
  const app = createApp(ctx);
  let id = 0;
  const post = (path: string, body: unknown, headers: Record<string, string | undefined> = {}) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers } as Record<string, string>, body: JSON.stringify(body) });
  return {
    app, ctx,
    async rpc(method: string, params?: unknown) {
      const res = await post("/mcp", { jsonrpc: "2.0", id: ++id, method, params });
      return (await res.json()) as { result?: any; error?: { code: number; message: string } };
    },
    /** Call an MCP tool; asserts the structured result satisfies the SOURCE output schema. */
    async tool(name: string, args: Record<string, unknown> = {}, opts: { skipSchema?: boolean } = {}): Promise<Rpc> {
      const res = await post("/mcp", { jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } });
      const body = (await res.json()) as { result: Rpc };
      const r = body.result;
      if (!r.isError && !opts.skipSchema) {
        const v = outValidators.get(name);
        if (v && !v(r.structuredContent)) throw new Error(`${name} output violates schema: ${JSON.stringify(v.errors?.[0])} in ${JSON.stringify(r.structuredContent).slice(0, 400)}`);
      }
      return r;
    },
    post,
    get: (path: string, headers: Record<string, string | undefined> = {}) => app.request(path, { headers: headers as Record<string, string> }),
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(fn: () => boolean | Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(25); }
  throw new Error("timed out waiting for condition");
}
