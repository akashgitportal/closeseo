import { withUsage } from "../services/usage.ts";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createRequire } from "node:module";
import type { Ctx } from "../ctx.ts";
import { AppError } from "../errors.ts";
import { HANDLERS } from "./tools.ts";
import { formatValidationError, extraRuleError } from "./validation.ts";
import { isSupportedLanguageCode } from "../services/markets.ts";

const require = createRequire(import.meta.url);
type ToolDef = { name: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown> } & Record<string, unknown>;
const SCHEMAS = require("./tool-schemas.json") as { tools: ToolDef[] };

// useDefaults mirrors schema defaults (e.g. pageSize 50). Unknown keys are rejected only where the tool schema sets additionalProperties:false.
const ajv = new Ajv2020.default({ strict: false, allErrors: true, verbose: true, useDefaults: true, coerceTypes: false });
addFormats.default(ajv);
const validators = new Map(SCHEMAS.tools.map((t) => [t.name, ajv.compile(t.inputSchema)]));

export const SERVER_INFO = {
  name: "closeseo MCP",
  title: "closeseo",
  version: "0.1.0",
  description: "SEO research tools for AI agents: keyword research and metrics, SERP results, domain and backlink analysis, rank tracking, site audits and shareable reports.",
};
export const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, any> };
type Reply = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

const err = (id: Rpc["id"], code: number, message: string): Reply => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export function listTools() {
  return SCHEMAS.tools;
}

/** A failed tool call: readable text plus a machine-readable code in `_meta` (the REST bridge maps it to an HTTP status). */
const fail = (text: string, errorCode: string) => ({ content: [{ type: "text", text }], isError: true, _meta: { errorCode } });

async function callTool(ctx: Ctx, baseUrl: string, name: string, args: Record<string, unknown>, clientLabel?: string) {
  const handler = HANDLERS[name];
  const validate = validators.get(name);
  if (!handler || !validate) return null;
  const input = { ...args };
  if (!validate(input)) {
    return fail(formatValidationError(name, validate.errors ?? []), "INVALID_INPUT");
  }
  const extra = extraRuleError(name, input, isSupportedLanguageCode);
  if (extra) return fail(extra, "INVALID_INPUT");
  try {
    const out = await handler(ctx, input, { baseUrl, clientLabel });
    const meta: Record<string, unknown> = {};
    if (out.url) meta.url = out.url;
    if (typeof input.projectId === "string") meta.projectId = input.projectId;
    return {
      ...(out.url ? { _meta: { url: out.url } } : {}),
      content: [{ type: "text", text: out.text }],
      structuredContent: { ...out.data, ...(Object.keys(meta).length ? { meta } : {}) },
    };
  } catch (e) {
    if (e instanceof AppError) return fail(e.message, e.code);
    console.error("mcp tool failure", name, e);
    return fail("The server hit an unexpected problem while running this tool. Details are in the server log.", "INTERNAL_ERROR");
  }
}

/** Handle one JSON-RPC message. Returns null for notifications. */
export async function handleRpc(ctx: Ctx, baseUrl: string, msg: Rpc, clientLabel?: string): Promise<Reply | null> {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string")
    return err(msg?.id, -32600, "Invalid Request");
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion as string | undefined;
      return {
        jsonrpc: "2.0", id: msg.id ?? null,
        result: {
          protocolVersion: asked && SUPPORTED_VERSIONS.has(asked) ? asked : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: "closeseo SEO tools. Paid DataForSEO-backed tools spend your DataForSEO balance; confirm with the user before large or repeated runs. Start with list_projects.",
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id: msg.id ?? null, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id: msg.id ?? null, result: { tools: listTools() } };
    case "tools/call": {
      const name = msg.params?.name;
      if (typeof name !== "string") return err(msg.id, -32602, "Missing tool name");
      const callArgs = (msg.params?.arguments as Record<string, unknown>) ?? {};
      const pid = typeof callArgs.projectId === "string" ? callArgs.projectId : undefined;
      const result = await withUsage({ projectId: pid }, () => callTool(ctx, baseUrl, name, callArgs, clientLabel));
      if (!result) return err(msg.id, -32602, `No tool is named ${name}`);
      return { jsonrpc: "2.0", id: msg.id ?? null, result };
    }
    default:
      return isNotification ? null : err(msg.id, -32601, "Method not found");
  }
}
