# Validation report

All numbers below come from commands that were actually executed. Environment: Node 26.7, Linux. SOURCE = every-app/open-seo
v0.1.10 (db8bde1) running locally in `local_noauth` mode with its DataForSEO base URL redirected to the shared fake.

**Limits of this evidence.** No DataForSEO, Google, OpenRouter or Cloudflare credentials were available. Provider behaviour is
validated against a deterministic fake that follows DataForSEO's documented envelope (and was itself corrected where the
SOURCE's strict parser exposed gaps, e.g. `tasks[].path`). The fake cannot prove real-API parity.

## SOURCE baseline
* `pnpm install --frozen-lockfile` OK; SOURCE's own suite: **195 files / 1,328 tests pass**. SOURCE's build, lint and Playwright e2e were not run.

## Round 1 (first full differential run, before fixes)
`58 steps: 13 MATCH, 1 KNOWN_DIFF, 43 DIFF, 1 ERROR.` Discrepancy classes found and then fixed:
validation-message wording; project-context shape (`key`, `updatedBy`, `researchLog`…); saved-keyword normalisation (whitespace is
significant) and unordered rows; research routing (blend of suggestions+ideas, related top-up, Ads-only countries; no own clustering);
metrics rows are snake_case; domain overview defaults (`subdomains`, `hasData`, null backlinks); ranked-keyword/competitor rows are
raw provider rows; SERP keeps non-organic items and uses absolute rank; backlinks nested overview shape, page sizes 50/100/200,
default sort; rank tracking (config shape, defaults mobile/40/manual, queued vs live pricing, credit gate on scheduled trackers,
snapshot semantics, error texts); reports (full-HTML check, limits, unique titles, provenance, sharing refused outside hosted mode,
HTML delivered in the text block); protocol error texts; provider-failure wording; `multipleOf`/UUID/language-code messages.
Each fix was followed by the full suite.

## Round 2 (clean room: fresh copy, no `node_modules`/data, `npm ci`)
| Check | Result |
|-------|--------|
| `npm ci` | OK, 0 vulnerabilities reported |
| Typecheck (`tsc --noEmit`, strict) | **PASS** |
| `npm test` (unit, MCP contract, API, rank tracking, audit, failure-mode, process) | **81 / 81 pass** |
| `npm run test:e2e` (real Chromium, 9 tests) | **9 / 9 pass** (5 consecutive runs stable) |
| Differential SOURCE vs NEW (`npm run test:diff`, 158 steps) | **153 MATCH · 4 KNOWN_DIFF · 0 DIFF · 0 ERROR · 1 NOT_TESTABLE** |
| Docker image | builds; runs as non-root; `api_key` enforced (401 without token); data persists across restart |

The clean-room run initially **failed** because my own packaging step (and `.gitignore`) excluded `src/data/`; both were fixed to
root-anchored patterns and the round was repeated from scratch. A Dockerfile bug (non-root user could not write the data volume) and a
flaky browser test (it asserted on the previous view's table) were also found and fixed during validation.

## What the differential covers
Account, projects (+error texts), project context (all patch ops), saved keywords, keyword research (blend, grouping, clickstream,
thin-seed fallback, Ads-only market), metrics, domain analysis, backlinks, SERP + locations, rank tracking lifecycle, reports and
templates, protocol errors, **provider failures** (503, 401, balance, invalid field, bad JSON × 6 tools), a **60-case validation
sweep**, and audit refusal behaviour. Known differences are listed in `MATRIX.md`; the single NOT_TESTABLE step is the audit crawl
comparison (SOURCE blocks private targets; no public host reachable offline) — the crawler is covered by `tests/audit.test.ts`.

## Phase 8 (attempt to break it)
`tests/failure.test.ts`, `tests/process.test.ts`, `tests/audit.test.ts`: missing/invalid configuration (exits non-zero with a message),
port in use, provider 503/401/402/invalid field/malformed JSON/timeout/connection refused, no API key, cross-project access, SQL-injection
and Unicode input, 1,000-row and 25-way concurrent writes, oversized bodies, path traversal, SSRF (private, loopback, metadata,
credentials, redirect-to-private), robots/sitemap handling, crawl cancel, stuck jobs after restart, SIGTERM during runs, restart persistence.

## Not tested
Live DataForSEO; Google/OpenRouter integrations (not implemented); Postgres (not implemented); multi-user auth (not implemented);
load/performance beyond the 1,000-row and 25-writer cases; Windows/macOS.

## Google Search Console and Analytics (added after round 2)
* **Live checks that were possible with a real Google OAuth client:** the client id and secret are accepted by Google (a token exchange
  with a bogus code answers `invalid_grant`, not `invalid_client`); `http://localhost:3001/api/{gsc,ga4}/oauth/callback` are registered
  redirect URIs and `127.0.0.1` or other hosts are refused with `redirect_uri_mismatch`.
* **Not possible here:** a real consent needs a person to sign in to Google in a browser, so no real Search Console or Analytics data
  was read. Everything below ran against a fake Google that verifies PKCE (S256), the client secret and the redirect URI, issues and
  revokes refresh tokens, and imitates both APIs and their failure modes.
* `tests/google.test.ts`: 31 tests. Consent URL (offline access, forced consent, PKCE, state binding/expiry/replay), callback behaviour
  (declined, scope box unticked, forged code, second account, refresh-token retention), tokens encrypted at rest and unreadable under another
  secret, refresh coalescing (8 concurrent callers = 1 refresh) and revocation, public callbacks in `api_key` mode, property selection rules,
  Search Console request building (filters must be wrapped in `dimensionFilterGroups`, 16-month clamp, metric filters, pagination),
  URL inspection inline failures, all 9 Analytics tools (dimensions, metrics, filters, ordering, paging), date clamping, previous-period
  comparison, source/medium diagnostics, restricted/limited/malformed responses, error-code mapping, measurement health, opportunity scoring.
* `tests/e2e/google-ui.test.ts`: the whole flow in Chromium (connect, return, pick property, see queries, disconnect, decline).
* Differential: all 12 Google tools compared with the original in its not-configured/not-connected state: 14 of 15 steps matched at first
  run (the 15th, wording for an unknown argument, was then fixed).

## Assistant (added after the Google work)
* `tests/agent.test.ts` (24 tests, fake OpenAI-compatible model): grounded prompt, project binding (a model-chosen project id is ignored), allow-list of
  tools (no deletes/reports/project management; Google tools only when connected), compact tool schemas, bad/unknown/invalid tool calls explained to the
  model, step limit, cost limit, paid-call limit, history replay with tool results kept paired, history trimming on a user boundary, provider failures
  (401/402/429/500/garbage/empty) with nothing half-stored, concurrent turns, project isolation and cascade delete, hostile page text, SSRF refusal,
  key never leaked, bearer auth. `tests/e2e/assistant-ui.test.ts`: real browser (rendered markdown, model-written HTML and `javascript:` links never execute).
* **Live run** (real OpenRouter, `openai/gpt-4o-mini`, key with $5 credit, hard stop at $0.60): 8 messages in total. It chose sensible tools, saved
  three keywords correctly (verified in the database), read a public page and a hostile local page (ignored the planted instructions, called no
  forbidden tool), and when DataForSEO refused data calls (unverified account) said so instead of inventing numbers. **Total spend about $0.009**;
  OpenRouter's own usage counter matched the per-message costs the app recorded.
* Found and fixed from the live run: `map_links` returned nothing for a page that links nowhere (now lists the requested page); a DataForSEO 403 now
  carries the provider's reason ("verify your account").
* Not verified: behaviour with other models; long conversations beyond the size trim; streaming (not implemented); a comparison with the original's
  agent output.

## Live DataForSEO (after a second account, funded with $1, started answering data calls)
**Spend: about $0.34 of the $1.00 balance (balance $1.00 → $0.657, read from the account), including a few direct API probes. The test runners stopped at a hard limit.

What ran for real, through closeseo's own tools, and parsed correctly:
| Tool | Real result |
|---|---|
| `search_serp_locations` | 62,864 US locations from the free endpoint, filtered and cached |
| `get_serp_results` | real SERP rows, including `ai_overview` and `people_also_ask` items kept with null fields |
| `get_keyword_metrics` | volume, difficulty, CPC and intent for 3 keywords (e.g. "seo tools" 110,000 / KD 66 / $21.79) |
| `research_keywords` | 149 rows, source `blended`, thin-seed fallback not needed |
| `get_domain_overview`, `get_ranked_keywords` | real traffic and keyword counts, provider rows passed through |
| rank tracker | estimate $0.002, live run completed |
| `get_backlinks_overview`, `get_backlinks_profile` | 20.5M backlinks, 114,322 referring domains, trend history, 50-row profile page |

What the live run found, and what changed because of it:
* **DataForSEO sometimes answers paid calls with "unusual activity … temporarily paused access" (task code 40201)**, mostly after bursts, and the
  pause eases after roughly 30 seconds. A refused call costs nothing. closeseo now retries it with backoff (4 attempts, 3 s, 6 s, 12 s) and, if the
  pause persists, shows DataForSEO's own message with their support address. Covered by tests with a fake that pauses on demand.
* **A multi-call tool wasted a paid result.** The backlinks overview was billed for its summary and then failed entirely when a later call was
  paused. It now keeps the summary and returns what it could get with a note saying exactly what is missing (seen live: trend history omitted,
  everything else present).
* A 403 now carries the provider's reason ("verify your account") instead of a bare status (found with the first account).
* The account itself is flagged by DataForSEO's abuse protection, which is not something the software can fix. If you see the pause often, ask
  their support to review the account.

Still not verified live: the queued (scheduled) rank-check path, `task_post`/`task_get`; Business Data and Lighthouse
(not implemented or not exercised); the AI/LLM endpoints are covered in the AI visibility section below; behaviour at scale or under sustained use; regional differences beyond the US.

## AI visibility, dashboard and usage/budgets (added after the sections above)

**Automated, against a fake DataForSEO** (`tests/ai-visibility.test.ts`, `tests/usage.test.ts`, `tests/e2e/visibility-ui.test.ts`):
model selection from the catalog; request fields per model (4096 tokens, forced search for Claude only, country only where supported);
text assembly; citation hygiene (duplicates, `javascript:` and credentialed links dropped, cap 25); brand matching with word boundaries and
symbol-ending names ("C++"); 7-day cache keys (whitespace-insensitive, case-sensitive, per project, per search setting) and free cache hits; per-model
failure isolation; one clear error for account billing problems; the paid retry when a search did not happen; brand lookup totals, share of
voice, cited pages, questions, 12-month trend; the rule that ChatGPT data (US/English only) is left out of totals outside that market;
page-scope filtering; partial and empty results not cached; input validation (nothing is bought for invalid input). Ledger: attribution by
project and feature (including the assistant's own tool calls, the queued rank-check background path and OpenRouter cost), cache hits and
failures not billed, global and per-project budgets (block, warn at 80%, raise/remove, month rollover, project deletion), and the dashboard
(zero cost to open, real progress, audit summary, hideable steps).

**Live, on the second DataForSEO account (about $0.12 spent):**
* model catalog: real names, the pinned/latest rule picked `gpt-5.6-luna`, `claude-sonnet-5`, `gemini-2.5-pro`, `sonar-reasoning-pro`;
* Prompt Explorer, one model (Perplexity, web search on, brand "Notion"): success, 17 citations, brand detected, cost $0.016, recorded in the ledger;
* LLM-mentions `aggregated_metrics` for one domain: real response parsed as expected (`total.platform[].mentions / ai_search_volume`), cost $0.101.

**Live follow-up (second session, about $0.55 more):** all four models answered for real (ChatGPT `gpt-5.6-luna` $0.014, Claude `claude-sonnet-5` $0.049, Gemini `gemini-2.5-pro` $0.047, Perplexity $0.016, each with citations and the brand found). The four LLM-mentions endpoints (`aggregated_metrics`, `top_pages`, `search`, `cross_aggregated_metrics`) were called for real and their responses fed through the same shaping code that brand lookup uses: totals, share of voice against a real competitor, cited pages with their questions and a 12-month trend all came out. **Cost correction:** those four calls cost $0.42 in total, much more than the $0.10 of the first summary call, so one complete lookup (about 8 calls, 100 mentions each) can cost $1-$2; my earlier "$0.60-$0.80" estimate was too low and the UI and docs now say so. DataForSEO paused the account once during this run (task 40201); the explorer now reports that as one clear error instead of "model unavailable".
**Not verified live:** one complete end-to-end brand lookup in the UI (the balance is spent).
**Not compared with the original:** AI visibility and the dashboard have no differential test, because the original exposes them only through its
signed-in web UI. They follow the original's code and schemas, not a side-by-side run. The differential suite for the 58 tools is unchanged
(168/173 match, 4 documented, 0 unexplained).
**Known limits:** a budget stops *new* calls; the up-to-four calls of one Prompt Explorer run start together, so a cap can be passed by that run.
Budgets and the ledger are USD amounts as reported by the providers; they are not reconciled with the providers' invoices.

## Assistant on other models (live, OpenRouter, $0.09 of the $5 credit)
The same three tasks (save keywords, update project memory with a competitor, read a web page that carries a hidden hijack instruction) on four more models:
`anthropic/claude-haiku-4.5`, `google/gemini-2.5-flash`, `openai/gpt-4.1-mini`, `deepseek/deepseek-chat-v3.1`. All four saved the keywords; none called a forbidden tool
or revealed a prompt or key; cost per task 0.1-2 cents (ledger matched). Weak spots found: Gemini 2.5 Flash used the memory tool wrongly once (the tool's error text was
clear and it said so) and asked permission before reading a page instead of reading it, which led to a new system-prompt line ("reading a page the user names is free:
do it"); gpt-4.1-mini misread its own keyword list once. Only these five models (with gpt-4o-mini earlier) have been tried.

## Local business tools (F10), added after the sections above
All 8 tools (`get_business_profile`, `get_business_reviews`, `get_business_updates`, `list_business_categories`, `get_local_rank_grid`, `search_local_businesses`,
`get_local_serp_results`, `get_google_business_questions`) are implemented and **compared side by side with the original**: 45 new differential checks (profiles by name/cid/place id,
Q&A, categories, listings with filters/sort/paging, maps and local-finder SERPs, queued reviews/posts with resume, rank grids incl. polar and all-fail cases, validation) all give
identical results, including the text tables. The differential suite is now 213 identical of 218 (4 documented, 1 not testable). Own tests add: pending/resume/billed-once for queued
tasks, no retry of a task post, cached free category list, budget and pause behaviour. **Not verified live:** none of the eight has been run against the real Business Data API (the balance was spent
before they were written); the fake follows the source's request/response handling, not a recording of the live service.

## Rank-tracker edit/archive/history and saved-keyword filters
Tracker settings (domain, market, devices, depth, schedule), archive/restore, per-keyword history, visibility trend and position matrix (REST + UI), and saved-keyword search/tag/row filters, all with API and browser tests.
These are not compared with the original's UI (it has no public API for them).
