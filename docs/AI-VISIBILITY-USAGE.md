# AI visibility, dashboard, usage and budgets

## AI visibility (tab "AI visibility")
**Prompt explorer** asks one question of 1-4 assistants (ChatGPT, Claude, Gemini, Perplexity) through DataForSEO's `ai_optimization`
API and shows the answers side by side with their cited sources and the searches each model ran. Options: highlight a brand (a citation matches
if its URL or title contains the brand; the text matches as a whole word), turn web search off, pick a search country (Gemini has none;
Claude supports a shorter list). One paid call per model (about 1-2 cents); answers are cached 7 days per project/model/prompt/settings.
If web search was requested but the model skipped it, one paid retry is made and kept only if it searched.

**Brand lookup** shows how often AI search mentions a brand, domain or keyword (DataForSEO LLM mentions): mentions and AI search volume per
platform, share of voice against up to 5 competitors, the most cited pages, the questions that mention it and a 12-month trend. About 6-8 paid
lookups. Measured on a real account: $0.10 for one summary call, and four calls (summary, top pages, 20 mentions, a two-brand comparison) cost $0.42, so a full lookup with 100 mentions per platform can reach $1-$2; cached 24 hours. ChatGPT data is US/English only, so for other markets it is shown per platform but left out of totals,
trend and share of voice. Scope (`subfolder`, `exact_url`) filters pages and questions; totals stay domain-level and the page says so.

REST: `POST /api/projects/:id/ai/prompt`, `POST /api/projects/:id/ai/brand`, `GET /api/projects/:id/ai/runs[/:rid]`, `GET /api/ai/models`.
These are not MCP tools: the 58-tool contract is unchanged.

## Dashboard
Per-project overview from local data only (opening it never costs money): setup steps (hideable), saved/tracked keywords, average
position, top-10 count, latest audit issues, latest brand lookup, connections and this month's spend. `GET /api/projects/:id/dashboard`.

## Usage and budgets
Every billed DataForSEO call and every OpenRouter call is recorded with the cost the provider reported, the project and the feature
(keywords, domain, backlinks, SERP, rank tracking, AI visibility, audit, assistant). The **Usage** page (header link, and a tab per project)
shows the month by provider, feature, project and day, plus the latest calls. A **monthly budget** (overall or per project, USD, UTC calendar month)
makes new paid calls fail with HTTP 402 / `BUDGET_EXCEEDED` and a message saying what to change; a warning shows from 80%.
`GET /api/usage?projectId=&days=`, `GET|PUT /api/budgets`.

Limits: a running request is not interrupted, and the up-to-four calls of one prompt run start together, so a cap can be passed by that run.
The ledger is what the providers reported per call, not an invoice. There is no payment processing: if you want hosted-style credit packs or
subscriptions, that is a separate piece of work (a payment provider, accounts and webhooks).
