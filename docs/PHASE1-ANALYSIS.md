# Phase 1 Analysis — SOURCE: every-app/open-seo @ db8bde1 (v0.1.10)

Evidence base: static inspection of the cloned repo (1,688 files; ~146k lines TS/TSX in `src/`,
195 test files, 284 files in `web/`). Nothing has been built or executed yet
(`pnpm` is not installed in this environment; Node 26.7, Docker 29.7 are present).

## 1. Architecture of SOURCE
- Full-stack TypeScript on **Cloudflare Workers**: TanStack Start (React 19, Router, Query, Form, Table), Vite 7, Tailwind 4, shadcn on Base UI.
- Server pattern: TanStack server function (`src/serverFunctions/*`) -> service (`src/server/features/*/services`) -> repository (Drizzle).
- Persistence: Drizzle with **dual dialect** (D1/SQLite default, Postgres via Hyperdrive). 29 PG + 36 SQLite migrations. KV (cache, OAuth store), R2 (cache/storage), Durable Object `SamChatAgent` (SQLite chat history).
- Async: Cloudflare Workflows `SiteAuditWorkflow` (separate `open-seo-audit` worker, Lighthouse + crawl, scratchpad DO) and `RankCheckWorkflow`; cron `*/5` (rank checks, stale-audit reconcile) and daily 03:17 (OAuth KV GC).
- Three auth modes: `cloudflare_access` (JWT via jose), `local_noauth` (injected admin@localhost), `hosted` (Better Auth: email/password, Google, organizations/invites, API keys).
- MCP server (`/mcp`) with OAuth provider (workers-oauth-provider) + API-key auth; ~58 tools.
- In-app agent "SAM" (Agents SDK / Think, OpenRouter models, skills, tools).
- Billing (hosted only): Autumn + Svix webhooks, Loops emails, PostHog, Dub referrals.
- Marketing/docs site in `web/` (separate Worker, MDX content, blog, free tools, OG images).
- Packaging: Docker image running wrangler/workerd (`deploy/docker`), Alchemy deploy scripts, Playwright e2e, `tests/badseo` fixture site for audits.

## 2. Feature inventory (grouped; each needs trigger/input/process/output/deps/edge/test in the matrix)
| ID | Capability | Primary source areas |
|----|-----------|----------------------|
| F01 | Projects CRUD, project scoping on every server fn | features/projects, serverFunctions/projects |
| F02 | Keyword research (seed/domain/related, filters, scopes, metrics cache, routing among data sources) | features/keywords, lib/dataforseo/labs, spec 0004 |
| F03 | Saved keywords + tags, tag colors, assignments | features/saved-keywords |
| F04 | SERP results, SERP locations search/validation | lib/dataforseo/serp*, serp-locations |
| F05 | Domain overview, ranked keywords, keyword suggestions, SERP competitors | features/domain |
| F06 | Backlinks overview/profile/snapshots | features/backlinks |
| F07 | Rank tracking: configs, keywords, scheduled + manual runs, snapshots, cost estimate, local locations | features/rank-tracking, RankCheckWorkflow, spec 0008 |
| F08 | Site audit: crawl (robots, sitemap discovery, throttle, SSRF url-policy), page analyzer, ~issue catalogue, Lighthouse, optional JS rendering (Context.dev / Browser Run), progress, cancel, delete, reconciler | features/audit, lib/audit, SiteAuditWorkflow, spec 0009 |
| F09 | AI visibility: prompt explorer, brand lookup, LLM mentions (DataForSEO AI/LLM endpoints) | features/ai-search, lib/dataforseo/ai |
| F10 | Local SEO: business search/profile/reviews/updates/questions, categories, local rank grid | lib/dataforseo/business, mcp local-seo-tools |
| F11 | Google Search Console OAuth + performance + URL inspection + search opportunities | features/gsc, google, spec 0003 |
| F12 | Google Analytics 4 OAuth + 9 report tools | features/ga4, spec 0007 |
| F13 | Project memory/context (sections, key pages, competitors, research log) | features/project-context, spec 0010 |
| F14 | Reports (dynamic), report templates, public share links (`/s/:token`, `/raw`, `og.png`, `/r/:id`) | features/reports, specs 0012-0014 |
| F15 | Dashboard + activation steps/dismissals, onboarding questions | features/dashboard, activation |
| F16 | SAM in-app agent (chat, tools, skills, session persistence, OOM guard) | features/sam |
| F17 | MCP server: transport (stateless + v2), OAuth consent/registration, API-key auth, tool instrumentation, output schemas | server/mcp |
| F18 | Auth: 3 modes, sign-in/up, verify email, reset password, org members/invites, last-active org | server/auth, middleware |
| F19 | Billing/credits (hosted): Autumn, webhooks, fix-payment, lifecycle emails, referrals | server/billing, referrals |
| F20 | Settings: DataForSEO/OpenRouter key help, integrations, GDPR erasure | routes/_app/settings, gdpr |
| F21 | Health, setup-status gate, self-host telemetry heartbeat (opt-out), security headers (`frame-ancestors 'self'`) | api/health, server.ts |
| F22 | Agent plugin: 10 shipped skills + Claude/Codex/Cursor plugin manifests | plugins/openseo |
| F23 | Marketing/docs/blog website + free tools | web/ |
| F24 | Ops CLI scripts (seed, repair, erase user, usage/billing profiles, D1->PG migration) | scripts/ |

## 3. Public / external interfaces (compatibility-required)
- HTTP: `/api/health`, `/api/auth/*` (Better Auth), `/api/autumn/*`, `/api/ga4/oauth/callback`, `/api/gsc/oauth/callback`, `/mcp` (+ OAuth endpoints, `/.well-known/*`), `/s/:token[/raw|/og.png]`, `/r/:reportId`, GDPR storage-erasure path, Autumn webhook path.
- UI routes (see `src/routes`, 50+ files): `/`, `/projects`, `/p/:id/{keywords,saved,domain,backlinks,rank-tracking[/:cfg],audit[/issues/:r],brand-lookup,prompt-explorer,search-performance,reports[/:id|/templates],context,sam,settings/*}`, billing, onboarding, auth pages.
- MCP tool names/schemas (58, listed in `src/server/mcp/tools`) — **must** stay byte-compatible with agent skills.
- Env vars: `DATAFORSEO_API_KEY, AUTH_MODE, TEAM_DOMAIN, POLICY_AUD, BETTER_AUTH_SECRET/URL, GOOGLE_CLIENT_ID/SECRET, OPENROUTER_API_KEY/MODEL, CONTEXT_API_KEY, PORT, ALLOWED_HOST, OPENSEO_TELEMETRY_DISABLED, DO_NOT_TRACK`, plus hosted-only POSTHOG/LOOPS/Autumn/Svix/Dub vars.
- Docker contract: `compose.yaml` (port 3001, `.env`, volume for state).
- Upstream API contract: DataForSEO v3 (Basic auth, base64 `login:password`).

## 4. Dependency / integration inventory
DataForSEO (SERP, Labs, Backlinks, Business Data, On-Page/Lighthouse, AI/LLM); OpenRouter; Google OAuth/GSC/GA4/Business; Better Auth; Autumn+Svix; Loops; PostHog; Dub; Cloudflare (D1, KV, R2, DO, Workflows, Access, Browser Run, Hyperdrive, Alchemy); Context.dev; Turnstile; MCP SDK 1.30/2.0; Drizzle; Postgres.
**None of the paid/credentialed services are available here** -> require a recorded/mocked DataForSEO server shared by SOURCE and NEW for differential runs.

## 5. License / NOTICE assessment
- Root `LICENSE`: **MIT, (c) 2026 Ben Senescu**. No NOTICE file found at root. `web/` and `plugins/` licensing not yet checked individually; dependency licenses not yet audited (`pnpm licenses` after install). Blog/marketing copy, images, avatars, demo video, logos and the "OpenSEO" name/brand are not clearly covered by MIT code grant and must **not** be copied into the new repo.
- MIT obligation applies only to copied "substantial portions". A clean-room-style independent implementation copies none, but behavior-derived details (schemas, tool descriptions, prompts, SQL migrations, skill text) are close to expression; I will write these independently and, as a precaution, keep an attribution/acknowledgement of the upstream project in README. Rewriting does not remove trademark/brand issues: the new product needs its own name/branding.

## 6. Proposed architecture for NEW
Honest constraint: SOURCE is ~146k LOC bound to Cloudflare-only primitives. A literal 1:1 port is multi-week work. Proposal:
- **Runtime**: Node 22 + Hono (HTTP/MCP/API) + React 19/Vite SPA (TanStack Router/Query) — avoids Workers lock-in and makes Docker self-host first-class.
- **DB**: Drizzle + Postgres (and SQLite via better-sqlite3 for local); single normalized schema.
- **Jobs**: in-process durable queue (DB-backed `jobs` table + worker loop + cron scheduler) replacing Workflows/DO/cron.
- **Cache/KV/Blob**: DB tables + filesystem.
- **Layers**: route -> service -> repository; `providers/dataforseo` behind an interface (real + record/replay mock).
- **MCP**: `@modelcontextprotocol/sdk`, same tool names/schemas, API-key + OAuth.
- **Auth**: same 3 modes (`local_noauth`, `cloudflare_access`, `hosted`).
- Phased delivery by feature ID, matrix tracked in `docs/MATRIX.md`.

## 7. Testing / differential strategy
1. Build and run SOURCE locally (Docker image or `wrangler dev`, `local_noauth`) with `DATAFORSEO_BASE_URL`-style override… **caveat:** SOURCE may hard-code DataForSEO's host; if so, intercept via a local HTTPS proxy / `/etc/hosts` + custom CA, or `fetch` patch in a test harness.
2. Shared **fake DataForSEO server** (fixture-driven) used by both implementations.
3. Black-box harness (Vitest + Playwright) sends identical requests to both: HTTP routes, MCP `tools/list` + `tools/call`, server-function payloads, then normalizes (ids, timestamps) and diffs. Audit feature compared against `tests/badseo` fixture site.
4. DB-effect comparison through API read-backs (schemas differ by design).
5. Reuse SOURCE's 195 test files as behavioral specs only where they exercise public contracts.
6. Nondeterministic bits (LLM/SAM, Lighthouse scores) compared by invariants/schema.
7. Two full clean-state validation rounds + fault-injection round, per the brief.

## 8. Known untestable-without-credentials
DataForSEO live, OpenRouter, Google OAuth/GSC/GA4, Autumn/Svix/Loops/PostHog/Dub, Cloudflare Access/Browser Run/Hyperdrive/Alchemy deploys, Context.dev.
