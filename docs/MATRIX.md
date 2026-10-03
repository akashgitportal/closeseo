# Feature compatibility matrix — closeseo vs every-app/open-seo v0.1.10

Status legend: **PASS** implemented and verified (evidence in the last column) · **PARTIAL** implemented with stated gaps ·
**NOT IMPLEMENTED** not in this release (deliberate scope cut, see below) · **N/A** not applicable to a self-hosted Node build.

"Differential" = an identical call sequence was sent to the running SOURCE and to closeseo against the same fake DataForSEO
server and the normalised results were compared (`docs/DIFFERENTIAL-TESTING.md`). Most rows were validated only
against a fake that follows DataForSEO's documented envelope. A later live run (see VALIDATION.md) confirmed the keyword, SERP, domain,
backlink and rank-tracking calls against the real API.

| ID | SOURCE capability | closeseo | Status | Validation |
|----|------------------|----------|--------|-----------|
| F01 | Projects: create/list/update/delete, default market, domain normalisation, project scoping of every operation | `src/services/projects.ts`, REST + MCP | **PASS** (single-tenant: no organisations) | differential (`projects`), `mcp-contract`, `api`, cross-project isolation test in `failure` |
| F02 | Keyword research: blended suggestions+ideas, related top-up, Google-Ads-only countries, clickstream, grouping flag, local (city) volume, 24 h cache, metric persistence | `services/keywords.ts`, `services/markets.ts` | **PASS** | differential (`keyword-research`: labs, grouped, clickstream, thin-seed fallback, Iceland); local-volume + cache verified in `mcp-contract` against the fake only |
| F02b | `get_keyword_metrics` (Labs overview / Ads search_volume, 700-batch, sorting, trends toggle) | same | **PASS** | differential |
| F03 | Saved keywords: save with metrics, tags (append/replace), search, tag filter, remove | `services/savedKeywords.ts` | **PARTIAL** — MCP semantics PASS; the SOURCE web UI's filters/sorting/pagination/tag colours are not implemented | differential (`saved-keywords`), `mcp-contract`, browser test |
| F04 | SERP results (types kept, absolute rank, local location names), location search + cache | `services/serp.ts` | **PASS** | differential (`serp`) |
| F05 | Domain overview, ranked keywords (scope filters, sorting, paging), keyword suggestions, SERP competitors | `services/domain.ts`, `researchScope.ts` | **PASS** | differential (`domain-analysis`) |
| F06 | Backlinks overview (trends, referring domains, subfolder totals) and profile (filters, paging, spam default) | `services/backlinks.ts` | **PASS** | differential (`backlinks`) |
| F07 | Rank tracking (plus edit/archive, per-keyword history, trend and position matrix): config (defaults, location, schedule), keywords (match-case, caps, credit gate), cost estimate, manual live run, scheduled queued run with live fallback, results with previous position, restart recovery | `services/rankTracking.ts`, `rankPricing.ts`, `schedule.ts` | **PARTIAL** — all MCP-visible behaviour PASS; not implemented: archive/edit config, metrics refresh after adding keywords, SERP-feature enrichment beyond item types | differential (`rank-tracking`, with `CREDIT_MARKUP=1.28`), `rank-tracking` suite (queued path, fallbacks, scheduler, recovery) |
| F08 | Site audit: crawl, robots.txt, sitemaps, throttling, SSRF policy, issues, per-page data, cancel, delete, restart reconcile, Lighthouse | `src/audit/*`, `services/audit.ts` | **PARTIAL** — independent engine with its own issue catalogue (26 issue types); *not* wire-compatible on issue taxonomy. Not implemented: JavaScript rendering (rejected with a clear error), Cloudflare Browser Run | `audit` suite against a local flawed fixture site; refusal behaviour compared by differential; crawl comparison **NOT TESTABLE** (SOURCE refuses private targets and no public host is reachable offline) |
| F09 | AI visibility: prompt explorer (1–4 LLMs, web search, country, citations, brand highlight, 7-day cache, retry when search is skipped), brand lookup (mentions, share of voice, cited pages, questions, trend, 24h cache) | `services/aiVisibility.ts`, AI visibility tab | **PARTIAL** — own implementation from the source's observable behaviour; **not differential-tested** (the original exposes this only through its signed-in UI, not MCP). Fake-provider tests + one live prompt call and one live mentions call | `ai-visibility`, `usage`, e2e `visibility-ui` |
| F10 | Local SEO tools (8 MCP tools: business search/profile/reviews/updates/Q&A, categories, local SERP, rank grid) | `services/local.ts` | **PASS (offline)** — 45 differential checks identical to the original; not run against the live Business Data API | differential (`local-*`), `local` |
| F11 | Google Search Console OAuth + 3 MCP tools (`get_search_console_performance`, `inspect_urls`; `get_search_opportunities` shares F12) | `src/google/*`, `services/gsc.ts`, `mcp/google-tools.ts`, Integrations screen | **PASS against a fake Google; NOT TESTED against live Google** (needs an interactive consent) | `google.test.ts` (31 tests), browser test of the full flow, differential for the not-connected behaviour; client id/secret and redirect URIs verified live against Google |
| F12 | Google Analytics 4 OAuth + 9 MCP tools (7 reports, overview, measurement health, search opportunities) incl. previous-period comparison, source/medium diagnostics, ecommerce/site-search activity, error mapping | `services/ga4.ts` | **PASS against a fake Google; NOT TESTED against live Google** | same |
| F13 | Project context (4 standard sections, custom sections, competitors, key pages, research log; atomic batch; per-op error text) | `services/context.ts` | **PASS** | differential (`project-context`) |
| F14 | Reports and templates (HTML validation rules, caps, unique titles, provenance, sandboxed viewing) | `services/reports.ts` | **PASS** for MCP + UI | differential (`reports`), browser test (sandbox) |
| F14b | Public share links `/s/:token`, `/raw`, OG image, `/r/:id` | share + raw + `/r` redirect implemented, **off by default** (the SOURCE also refuses outside hosted mode) | **PARTIAL** — `og.png` social image not implemented | `api` suite |
| F15 | Dashboard and setup steps (hideable); onboarding questions not built | `services/dashboard.ts`, Dashboard tab | **PARTIAL** — reads only local data; the original also refreshes a backlink snapshot from the provider, closeseo does not (costs money) | `usage`, e2e `visibility-ui` |
| F16 | SAM in-app AI agent (chat, project-scoped tools, project memory, web reading, per-turn cost control) | `src/agent/*`, Assistant tab | **PARTIAL** — own implementation of the same idea, not a port. Missing: streaming replies, the original's skills/playbooks, its onboarding flow, context compaction beyond a size trim, billing metering, its durable-object persistence | `agent.test.ts` (24 tests against a fake model), `e2e/assistant-ui.test.ts` (real browser), live run against OpenRouter (6 messages, about $0.006). **Not compared side by side with the original agent** (it runs inside Cloudflare durable objects and needs a frontier model at high cost) |
| F17 | MCP server: stateless JSON-RPC, 58 tools with identical schemas/descriptions, validation messages, defaults | `src/mcp/*` | **PASS** for all 58 tools (the 8 local-SEO tools offline only) | `tools/list` deep-equals the SOURCE contract; validation sweep of ~60 invalid-input cases compared by differential; all outputs validated against the SOURCE output schemas |
| F17b | MCP OAuth provider, dynamic client registration, consent screen | static bearer key (`AUTH_MODE=api_key`) instead. (Google OAuth for Search Console/Analytics is separate and implemented, see F11/F12.) | **NOT IMPLEMENTED** (different mechanism) | `api` suite |
| F18 | Auth modes: `local_noauth`, `cloudflare_access`, `hosted` (Better Auth, orgs, invites) | `local_noauth` + `api_key` | **PARTIAL** — `cloudflare_access` and `hosted` not implemented | `api`, `process` suites |
| F19 | Billing: spend ledger by provider/feature/project, monthly budgets (global and per project) that block new paid calls, Usage page. Payments, credits purchase, Autumn/Svix/Loops, referrals | `services/usage.ts`, Usage tab | **PARTIAL (own design)** — metering and caps only; payment processing is a hosted-service concern and is not built | `usage` |
| F20 | Settings, GDPR erasure CLI | project delete only | **PARTIAL** | `api` |
| F21 | Health endpoint, setup status, security headers, telemetry heartbeat | `/api/health`, `frame-ancestors 'self'`, `nosniff`; **no telemetry** by design | **PASS** (health shape is closeseo's own: no gsc/rendering checks) | `api` |
| F22 | Agent plugin + skills | — | **NOT INCLUDED** (content is the source project's; write your own) | — |
| F23 | Marketing/docs website | — | **NOT INCLUDED** (branding/content not copied) | — |
| F24 | Ops scripts (seed, repair, erase user, D1→PG migration) | — | **NOT IMPLEMENTED** | — |
| — | Self-host packaging (Docker/compose) | `Dockerfile`, `compose.yaml` | **PASS** | built and run: non-root, auth enforced, data survives restart |
| — | Postgres backend | SQLite only | **NOT IMPLEMENTED** | — |

## Known, documented differences (differential `KNOWN_DIFF`)

| Where | SOURCE | closeseo | Why |
|-------|--------|----------|-----|
| `serverInfo` | its own name/title/version/icons/websiteUrl | its own name/title/version | branding is not copied |
| `set_report_sharing(public:true)` | "Sharing is only available on hosted OpenSEO." | refused unless `ENABLE_PUBLIC_SHARING=1`, with its own message | same default behaviour, own wording |
| `run_site_audit` on a private target | bare code `CRAWL_TARGET_BLOCKED` | a descriptive sentence | friendlier; both refuse |
| `list_projects` | adds `organization`/`organizationId` | omitted | single-tenant |
| Cost estimates | include the hosted 1.28× markup even when self-hosted | raw DataForSEO prices by default; `CREDIT_MARKUP=1.28` reproduces the SOURCE exactly | you pay DataForSEO directly; the markup is a reseller margin |
| Scheduled checks on the web UI | — | same queued path as the SOURCE, but polling is in-process | no Cloudflare Workflows |
