export type Robots = {
  isAllowed(path: string): boolean;
  crawlDelayMs: number | null;
  sitemaps: string[];
};

type Rule = { allow: boolean; pattern: string };

function toRegex(pattern: string): RegExp {
  const end = pattern.endsWith("$");
  const body = (end ? pattern.slice(0, -1) : pattern)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${body}${end ? "$" : ""}`);
}

export function parseRobots(text: string, userAgent = "closeseobot"): Robots {
  const groups: { agents: string[]; rules: Rule[]; delay: number | null }[] = [];
  const sitemaps: string[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const line of text.split(/\r?\n/)) {
    const clean = line.replace(/#.*$/, "").trim();
    const m = clean.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [], delay: null };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === "sitemap") sitemaps.push(val);
    else if (cur && (key === "allow" || key === "disallow")) {
      if (val !== "" || key === "allow") cur.rules.push({ allow: key === "allow", pattern: val });
    } else if (cur && key === "crawl-delay") {
      const n = Number(val);
      if (Number.isFinite(n) && n >= 0) cur.delay = n * 1000;
    }
  }
  const ua = userAgent.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) => g.rules).map((r) => ({ ...r, re: toRegex(r.pattern), len: r.pattern.length }));
  const delay = chosen.find((g) => g.delay !== null)?.delay ?? null;
  return {
    crawlDelayMs: delay,
    sitemaps,
    isAllowed(path: string) {
      let best: (typeof rules)[number] | null = null;
      for (const r of rules) {
        if (!r.re.test(path)) continue;
        if (!best || r.len > best.len || (r.len === best.len && r.allow)) best = r;
      }
      return best ? best.allow : true;
    },
  };
}

export const ALLOW_ALL: Robots = { isAllowed: () => true, crawlDelayMs: null, sitemaps: [] };
