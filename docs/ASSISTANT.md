# The assistant

An optional chat assistant for each project (Assistant tab). It answers questions and does research by calling the same tools the
MCP server offers, scoped to the project you are in, using your project memory as context. It is CloseSEO's own implementation of the
idea behind OpenSEO's in-app agent ("SAM"): same purpose, different code, a cheaper default model and tighter limits.

## Turn it on

```sh
OPENROUTER_API_KEY=sk-or-...        # from https://openrouter.ai/keys. Create a key with a spending limit.
OPENROUTER_MODEL=openai/gpt-4o-mini # default; any OpenRouter model that supports tool calling
```

Restart CloseSEO. Without a key the tab explains how to enable it and nothing else changes.

## What it costs

You pay OpenRouter per token (shown per chat) plus your DataForSEO balance whenever it runs a paid lookup. With the default model a
normal message costs roughly **$0.001-0.003**. Hard limits per message, all configurable:

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_MAX_COST_USD` | 0.25 | model spend after which the turn stops and says so |
| `AGENT_MAX_STEPS` | 8 | model calls per message; after that it must answer without tools |
| `AGENT_MAX_PAID_CALLS` | 6 | DataForSEO-backed tool calls per message; the rest are refused |

## What it can and cannot do

* **Can:** keyword research and metrics, SERP, domain and backlink analysis, saved keywords, rank-tracker estimates and runs, audit results,
  project memory notes, and (when connected) Search Console and Analytics. It can read public web pages (`map_links`, `read_pages`).
* **Cannot:** delete anything, write or share reports, manage projects, create trackers or audits. Those tools are not offered to it.
* **Is told to:** never state a metric a tool did not return, check the research log before paying again, and ask before large batches
  or rank checks. These are instructions to the model, so the three hard limits above are what actually bound spend.

## Safety

* The project is bound by the server: a project id the model supplies is discarded.
* Web pages and tool output reach the model wrapped as untrusted data. A planted "ignore your instructions" page was tested live and ignored.
  No prompt can make it call a tool that is not on its list, and the destructive tools are not on it.
* Read-only fetches use the same private-network protection as site audits.
* A turn is stored only if it completes; a provider failure leaves the chat unchanged. Tool effects that already happened (for example
  saving keywords) are kept, and are safe to repeat.
* The key is read from the environment and never appears in prompts, responses, transcripts or health output.
* Anything a user types in the chat is sent to OpenRouter and the model provider. Do not put secrets in it.
