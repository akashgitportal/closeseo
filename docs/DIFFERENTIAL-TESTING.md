# Differential testing (SOURCE vs NEW)

`npm run test:diff` sends identical call sequences to the original open-seo (the *oracle*) and to closeseo, both
backed by the same deterministic fake DataForSEO server, normalises ids/timestamps/origins, and diffs the results.
Output: `tests/diff/out/report.json` (+ `source-full.json`, `new-full.json`).

## Starting the oracle

```sh
git clone https://github.com/every-app/open-seo oracle && cd oracle
pnpm install --frozen-lockfile
# the oracle hard-codes https://api.dataforseo.com; make it overridable (oracle copy only):
sed -i 's|^const API_BASE = "https://api.dataforseo.com";|const API_BASE = (globalThis as any).process?.env?.DATAFORSEO_BASE_URL ?? "https://api.dataforseo.com";|' src/server/lib/dataforseo/core.ts
printf 'AUTH_MODE=local_noauth\nDATAFORSEO_API_KEY=%s\nDATAFORSEO_BASE_URL=http://127.0.0.1:4010\n' "$(printf fake:fake | base64)" > .env.local
pnpm run db:migrate:local
pnpm exec vite dev --port 3002 --host 127.0.0.1
```

Then in closeseo: `ORACLE_URL=http://127.0.0.1:3002 npm run test:diff` (starts the fake on :4010 if it is not already running;
NEW is booted with `CREDIT_MARKUP=1.28` because the oracle applies its hosted markup to estimates even when self-hosted).

## Status values

`MATCH` identical after normalisation · `KNOWN_DIFF` differs for a documented reason · `DIFF` unexplained (fails the run)
· `ERROR` a side could not complete the scenario · `NOT_TESTABLE` could not be exercised.
