# Third-party notices

## every-app/open-seo (MIT) — compatibility acknowledgement

CloseSEO is an independent implementation, built to be behaviourally compatible with
[every-app/open-seo](https://github.com/every-app/open-seo) (v0.1.10, commit db8bde1). It does not include that project's source files.

**Status of this branch (`independent-rewrite`).** The prose and reference data that earlier versions took from that project were
rewritten or rebuilt from public sources: all tool and parameter descriptions and titles, error and result wording, the assistant
prompt, the country/language table (rebuilt from DataForSEO's public endpoints, Unicode CLDR and the IANA ISO 3166 list) and the
web-search country lists (public DataForSEO documentation). The author of this rewrite had read the original source beforehand, so
this is **not a clean-room implementation**, and an automated check still finds overlapping short phrases (mostly unavoidable code
terms, API values and field names).

What deliberately remains the same, because compatibility with existing agents and skills depends on it:
* MCP tool **names**, input-parameter **names, types, enums, bounds and defaults**, and structured result **field names** (`src/mcp/tool-schemas.json`, `tests/golden/mcp-tools-list.json`; only the prose in them is new).
* Behavioural rules and numbers where the same result is required: pricing and credit formulas, rank-check and scheduling rules, issue severities, GA4/GSC report definitions, scoring formulas and thresholds, local rank-grid geometry, AI-visibility caching and shaping rules.

Whether that residue needs attribution is a legal question for the organisation using this code. The original is MIT-licensed; if any
of it is treated as derived, the licence only requires keeping this notice with it:

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

**Not used:** the marketing site, blog and docs content, images, logos, the "OpenSEO" name and branding, agent-skill text.
Use your own product name if you redistribute this.

## npm dependencies

hono, @hono/node-server (MIT); ajv, ajv-formats (MIT); htmlparser2 (MIT); undici (MIT); tldts (MIT).
Run `npm ls --all` and a licence checker (e.g. `npx license-checker --summary`) before redistributing a bundled build.
