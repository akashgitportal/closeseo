# Third-party notices

## every-app/open-seo (MIT)

closeseo is an independent implementation written to be behaviourally compatible with
[every-app/open-seo](https://github.com/every-app/open-seo) (v0.1.10, commit db8bde1).
The server code in `src/` was written from scratch; it does not reuse that project's source files.

A small amount of **interface and reference data** derived from that project is included so that agents,
skills and clients built for it keep working. It is covered by the original MIT licence:

> MIT License — Copyright (c) 2026 Ben Senescu
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without limitation
> the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
> to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of
> the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
> THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
> CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
> IN THE SOFTWARE.

Files containing that derived data:

| File | What it is |
|------|-----------|
| `src/mcp/tool-schemas.json`, `tests/golden/mcp-tools-list.json` | The MCP tool names, descriptions and JSON Schemas (the public agent contract). |
| `src/data/web-search-countries.json` | The ISO country codes DataForSEO accepts for LLM web search, and the subset Claude supports. |
| `src/data/markets.json` | Country / DataForSEO location-code / language / Labs-vs-Google-Ads coverage table. |
| Error-message wording and result field names | Reproduced where agents or skills may depend on them. |
| Assistant system prompt and tool rules (`src/agent/*`) | Written independently; behaviour rules (never state unsourced metrics, ask before paid batches) follow the original's documented intent. |
| Google report definitions, scoring formula and result shapes (`services/ga4.ts`, `services/gsc.ts`) | Written independently from the behaviour of the original; the scoring formula and field names are the compatibility surface. |

**Not copied:** the marketing site, blog and docs content, images, logos, the "OpenSEO" name and branding, agent-skill text.
Rewriting code does not remove trademark or branding obligations: use your own product name if you redistribute this.

## npm dependencies

hono, @hono/node-server (MIT); ajv, ajv-formats (MIT); htmlparser2 (MIT); undici (MIT); tldts (MIT).
Run `npm ls --all` and a licence checker (e.g. `npx license-checker --summary`) before redistributing a bundled build.
