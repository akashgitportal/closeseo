import { writeFileSync, mkdirSync } from "node:fs";
import { startFakeDfs } from "../support/fake-dataforseo.ts";
import { FAKE_KEY } from "../support/harness.ts";
import { bootNew, deepDiff, makeSide, normalize, type Diff, type Side } from "./lib.ts";
import { SCENARIOS, type Scenario } from "./scenarios.ts";

const ORACLE = process.env.ORACLE_URL ?? "http://127.0.0.1:3002";
const FAKE_PORT = Number(process.env.FAKE_PORT ?? 4010);

async function up(url: string) { try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; } }

if (!(await up(ORACLE))) { console.error(`SOURCE oracle not reachable at ${ORACLE}. See docs/DIFFERENTIAL-TESTING.md for how to start it.`); process.exit(2); }
let fake: Awaited<ReturnType<typeof startFakeDfs>> | null = null;
const fakeUp = await fetch(`http://127.0.0.1:${FAKE_PORT}/__stats`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
if (!fakeUp) fake = await startFakeDfs({ port: FAKE_PORT });
const nu = await bootNew({ DATAFORSEO_API_KEY: FAKE_KEY, DATAFORSEO_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`, ALLOW_PRIVATE_AUDIT_TARGETS: "0", CREDIT_MARKUP: "1.28", RANK_POLL_MS: "200" });
const source = makeSide("SOURCE", ORACLE), neu = makeSide("NEW", nu.base);

type Row = { scenario: string; step: string; status: "MATCH" | "KNOWN_DIFF" | "DIFF" | "ERROR" | "NOT_TESTABLE"; note?: string; diffs?: Diff[] };
const rows: Row[] = [];
const fullA: Record<string, Record<string, unknown>> = {}, fullB: Record<string, Record<string, unknown>> = {};

for (const sc of SCENARIOS as Scenario[]) {
  const run = async (side: Side) => { try { return { out: await sc.run(side) }; } catch (e) { return { err: (e as Error).message }; } };
  const [a, b] = [await run(source), await run(neu)];
  if (a.err || b.err) {
    rows.push({ scenario: sc.name, step: "*", status: "ERROR", note: `SOURCE: ${a.err ?? "ok"} | NEW: ${b.err ?? "ok"}` });
    continue;
  }
  for (const step of Object.keys({ ...a.out, ...b.out })) {
    const nt = (a.out as any)?.[step]?.__not_testable ?? (b.out as any)?.[step]?.__not_testable;
    if (nt) { rows.push({ scenario: sc.name, step, status: "NOT_TESTABLE", note: nt }); continue; }
    const known = sc.known?.[step];
    const mode = sc.compare?.[step] ?? "exact";
    const sa = a.out![step], sb = b.out![step];
    (fullA[sc.name] ??= {})[step] = normalize(sa); (fullB[sc.name] ??= {})[step] = normalize(sb);
    if (sa === undefined || sb === undefined) { rows.push({ scenario: sc.name, step, status: "DIFF", note: "step missing on one side" }); continue; }
    const pa = mode === "exact" ? normalize(sa) : mode(normalize(sa)), pb = mode === "exact" ? normalize(sb) : mode(normalize(sb));
    const diffs = deepDiff(pa, pb);
    if (diffs.length === 0) rows.push({ scenario: sc.name, step, status: "MATCH" });
    else if (known) rows.push({ scenario: sc.name, step, status: "KNOWN_DIFF", note: known, diffs: diffs.slice(0, 12) });
    else rows.push({ scenario: sc.name, step, status: "DIFF", diffs: diffs.slice(0, 12) });
  }
}

await nu.stop(); await fake?.close();
const count = (s: Row["status"]) => rows.filter((r) => r.status === s).length;
const summary = { total: rows.length, MATCH: count("MATCH"), KNOWN_DIFF: count("KNOWN_DIFF"), DIFF: count("DIFF"), ERROR: count("ERROR"), NOT_TESTABLE: count("NOT_TESTABLE") };
mkdirSync("tests/diff/out", { recursive: true });
writeFileSync("tests/diff/out/source-full.json", JSON.stringify(fullA, null, 1));
writeFileSync("tests/diff/out/new-full.json", JSON.stringify(fullB, null, 1));
writeFileSync("tests/diff/out/report.json", JSON.stringify({ at: new Date().toISOString(), summary, rows }, null, 1));
const icon = { MATCH: "✔", KNOWN_DIFF: "≈", DIFF: "✖", ERROR: "!", NOT_TESTABLE: "–" } as const;
for (const r of rows) {
  console.log(`${icon[r.status]} ${r.scenario} › ${r.step}${r.note ? `  — ${r.note}` : ""}`);
  if (r.status === "DIFF" || r.status === "ERROR") for (const d of r.diffs ?? []) console.log(`     ${d.path}\n        SOURCE: ${JSON.stringify(d.source)?.slice(0, 160)}\n        NEW:    ${JSON.stringify(d.new)?.slice(0, 160)}`);
}
console.log("\n" + JSON.stringify(summary));
process.exit(summary.DIFF + summary.ERROR > 0 ? 1 : 0);
