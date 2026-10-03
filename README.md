# closeseo

A self-hostable SEO toolkit: keyword research, saved keywords, SERP and domain analysis, backlinks, rank tracking,
site audits and shareable reports — with a web UI **and an MCP server** so AI agents (Claude Code and others) can
use your SEO data directly. You bring your own [DataForSEO](https://dataforseo.com) account and pay them directly.

closeseo is an independent implementation, behaviourally compatible with
[every-app/open-seo](https://github.com/every-app/open-seo) (MIT). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

> **Status: 0.1.0, core feature set.** What is and is not implemented is listed honestly in
> [docs/MATRIX.md](docs/MATRIX.md). Google Search Console and Analytics are included but have **only been tested against a fake
> Google**, not a live account. The assistant (chat) is included and tested against a fake model plus a live model on a few dollars of credit. AI visibility (prompt explorer, brand lookup), a per-project dashboard and a usage ledger with monthly budgets are included (see [docs/AI-VISIBILITY-USAGE.md](docs/AI-VISIBILITY-USAGE.md)). All 58 agent tools are implemented, including the 8 local-business tools (compared side by side with the original, not run against the live Business Data API). Multi-user accounts and payment processing are **not** included.

## Quick start

Requires **Node.js ≥ 22.18** (uses the built-in SQLite and TypeScript type stripping; no build step).

```sh
npm install
cp .env.example .env            # then edit: set DATAFORSEO_API_KEY
printf '%s' 'LOGIN:PASSWORD' | base64     # value for DATAFORSEO_API_KEY
set -a; . ./.env; set +a
npm start                       # http://127.0.0.1:3001
```

Docker:

```sh
cp .env.example .env            # set DATAFORSEO_API_KEY and CLOSESEO_API_KEY (AUTH_MODE=api_key is the image default)
docker compose up -d --build
```

Without a DataForSEO key the app runs but every data feature reports exactly what to set.
Check `GET /api/health` for configuration status.

## Connect an AI agent (MCP)

The MCP endpoint is `POST /mcp` (stateless JSON-RPC over HTTP, protocol 2025-06-18). With `AUTH_MODE=api_key`
send `Authorization: Bearer <CLOSESEO_API_KEY>`.

```sh
claude mcp add --transport http closeseo http://127.0.0.1:3001/mcp
# with a key:
claude mcp add --transport http closeseo https://seo.example.com/mcp --header "Authorization: Bearer $CLOSESEO_API_KEY"
```

58 tools are listed with schemas identical to open-seo's, so existing agent skills keep working, and all 58 are implemented (the 8
local/Google Business tools need DataForSEO Business Data access on your account).

Search Console and Analytics (12 tools) need a Google OAuth client: see [docs/GOOGLE.md](docs/GOOGLE.md).
The optional chat assistant needs an OpenRouter key: see [docs/ASSISTANT.md](docs/ASSISTANT.md).

## Security model

* `AUTH_MODE=local_noauth` (default) has **no login**. It binds to `127.0.0.1`; the server warns loudly if you bind
  elsewhere. Do not expose it publicly — use `AUTH_MODE=api_key` or put your own auth in front.
* Site audits refuse private, loopback, link-local and cloud-metadata addresses (checked on every redirect hop and at
  connect time, so DNS rebinding cannot reach them). `ALLOW_PRIVATE_AUDIT_TARGETS=1` turns that off for testing only.
* Reports are written by agents from untrusted data, so they are rendered only inside a sandboxed iframe with a
  script-blocking CSP. Public share links are **off** unless `ENABLE_PUBLIC_SHARING=1`.
* Provider keys are read from the environment and never logged or returned by the API.

## Configuration

See [.env.example](.env.example). All variables: `DATAFORSEO_API_KEY`, `PORT`, `HOST`, `PUBLIC_URL`, `DATABASE_PATH`,
`AUTH_MODE`, `CLOSESEO_API_KEY`, `ENABLE_PUBLIC_SHARING`, `CREDIT_MARKUP`, `RANK_POLL_MS`, `RANK_QUEUE_TIMEOUT_MS`,
`DISABLE_SCHEDULER`, `ALLOW_PRIVATE_AUDIT_TARGETS`, `DATAFORSEO_BASE_URL`, and for Google: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CLOSESEO_SECRET`; for the assistant: `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `AGENT_MAX_COST_USD`, `AGENT_MAX_STEPS`, `AGENT_MAX_PAID_CALLS`.
Invalid values fail at startup with a clear message.

## Costs

DataForSEO bills you directly. Rank-check estimates use their published per-page prices (live vs queued) and are
reported both in USD and in "credits" (1 credit = $0.001) because the MCP tools take credit ceilings for approval.
Scheduled checks use the cheaper queued API and fall back to live checks for anything that fails or times out.
`CREDIT_MARKUP` (default `1`, i.e. raw price) exists so estimates can match a marked-up reseller such as the hosted
open-seo (which uses `1.28`).

## Costs, usage and budgets

closeseo has no payments of its own: you pay DataForSEO and OpenRouter directly. It records every billed call (the cost each provider
reports), attributes it to a project and a feature, and shows it on the **Usage** page. You can set a **monthly budget** overall or per
project; once it is reached, new paid calls are refused with a clear message until you raise the limit. A request that is already
running is never interrupted. Opening the dashboard never spends anything.

## Architecture

```
src/
  server.ts            process entry: config → DB → recovery → HTTP → scheduler → graceful shutdown
  app.ts               Hono app: health, /mcp, /api (UI + tool bridge), /s share routes, static UI
  mcp/                 JSON-RPC server; input validation against the published tool schemas; tool handlers
  google/              OAuth (PKCE, single-use state), AES-GCM token storage, refresh, Google API calls
  agent/               OpenRouter client, tool allow-list and project binding, step/cost/paid-call limits, chat sessions
  services/            projects, context, saved keywords, keyword research, domain, backlinks, SERP,
                       rank tracking (+pricing, schedule), site audit, reports,
                       AI visibility, dashboard, usage ledger & budgets
  audit/               SSRF policy, robots.txt, sitemap, crawler, HTML analyzer, issue catalogue
  dfs/client.ts        DataForSEO v3 client (live + queued tasks, error classification)
  db.ts                node:sqlite, versioned migrations, transactions
public/                dependency-free web UI (hash-routed SPA, no innerHTML)
tests/                 unit, MCP contract, API, rank tracking, audit, failure-mode, process tests + differential harness
```

Data is stored in a single SQLite file (`DATABASE_PATH`). Background work (rank runs, audits) runs in-process with
restart recovery: interrupted jobs are marked failed at startup and can be re-run.

## Development & testing

```sh
npm test            # full suite (needs no network or credentials: it uses a fake DataForSEO server)
npm run typecheck
npm run fake:dfs    # run the fake DataForSEO API on :4010
npm run test:diff   # SOURCE-vs-NEW comparison; see docs/DIFFERENTIAL-TESTING.md
```

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
