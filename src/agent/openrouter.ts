import { AppError } from "../errors.ts";
import type { Ctx } from "../ctx.ts";
import { checkBudget, recordSpend } from "../services/usage.ts";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type ToolDef = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };

export type Completion = {
  message: { content: string | null; tool_calls?: ToolCall[] };
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number };
  /** Real USD cost reported by OpenRouter (usage accounting); 0 when the provider did not report one. */
  costUsd: number;
  model: string;
};

/** One non-streaming chat completion through OpenRouter, with failures turned into messages a user can act on. */
export async function chatCompletion(
  ctx: Ctx,
  req: { messages: ChatMessage[]; tools?: ToolDef[]; toolChoice?: "auto" | "none"; maxTokens?: number },
): Promise<Completion> {
  const key = ctx.config.openrouterKey;
  if (!key) throw new AppError("NOT_CONFIGURED", "The assistant needs OPENROUTER_API_KEY.");
  checkBudget(ctx);
  let res: Response;
  try {
    res = await fetch(`${ctx.config.openrouterBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "closeseo" },
      body: JSON.stringify({
        model: ctx.config.openrouterModel, messages: req.messages, usage: { include: true }, max_tokens: req.maxTokens ?? 1800,
        ...(req.tools?.length ? { tools: req.tools, tool_choice: req.toolChoice ?? "auto" } : {}),
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    throw new AppError("UPSTREAM_UNAVAILABLE", `Could not reach OpenRouter: ${(e as Error).message}`);
  }
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!res.ok) {
    const detail = body?.error?.message ?? text.slice(0, 200);
    if (res.status === 401) throw new AppError("UNAUTHENTICATED", "OpenRouter rejected the API key. Check OPENROUTER_API_KEY.");
    if (res.status === 402) throw new AppError("UPSTREAM_ERROR", "OpenRouter says the account is out of credit. Add credit and try again.");
    if (res.status === 429) throw new AppError("UPSTREAM_ERROR", "OpenRouter is rate limiting this key. Wait a moment and try again.");
    throw new AppError(res.status >= 500 ? "UPSTREAM_UNAVAILABLE" : "UPSTREAM_ERROR", `OpenRouter error (${res.status}): ${detail}`);
  }
  const choice = body?.choices?.[0];
  if (!choice?.message) throw new AppError("UPSTREAM_ERROR", body?.error?.message ? `OpenRouter error: ${body.error.message}` : "OpenRouter returned an unexpected response.");
  const calls = (choice.message.tool_calls ?? []) as ToolCall[];
  const costUsd = typeof body.usage?.cost === "number" ? body.usage.cost : 0;
  if (costUsd > 0) recordSpend(ctx, { provider: "openrouter", endpoint: body.model ?? ctx.config.openrouterModel, costUsd });
  return {
    message: { content: typeof choice.message.content === "string" ? choice.message.content : null, ...(calls.length ? { tool_calls: calls } : {}) },
    finishReason: choice.finish_reason ?? null,
    usage: { promptTokens: body.usage?.prompt_tokens ?? 0, completionTokens: body.usage?.completion_tokens ?? 0 },
    costUsd,
    model: body.model ?? ctx.config.openrouterModel,
  };
}
