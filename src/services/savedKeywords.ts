import type { Ctx } from "../ctx.ts";
import { newId, nowIso, tx } from "../db.ts";
import { AppError } from "../errors.ts";
import { getProject } from "./projects.ts";

export type KeywordMetricsInput = {
  keyword: string;
  searchVolume?: number | null;
  cpc?: number | null;
  competition?: number | null;
  keywordDifficulty?: number | null;
  intent?: string | null;
  monthlySearches?: { year: number; month: number; searchVolume: number }[];
};

/** Storage key: trimmed and lower-cased; inner whitespace is significant (two keywords that differ only in inner spacing are different keywords). */
export const normKeyword = (k: string) => k.trim().toLowerCase();

export function saveKeywords(
  ctx: Ctx,
  projectId: string,
  input: {
    keywords: string[];
    metrics?: KeywordMetricsInput[];
    tags?: string[];
    tagMode?: "append" | "replace";
    locationCode?: number;
    languageCode?: string;
  },
) {
  const project = getProject(ctx, projectId);
  const locationCode = input.locationCode ?? project.locationCode;
  const languageCode = input.languageCode ?? project.languageCode;
  const tagMode = input.tagMode ?? "append";
  const firstSeen = new Map<string, string>();
  for (const raw of input.keywords) {
    const key = normKeyword(raw);
    if (key && !firstSeen.has(key)) firstSeen.set(key, raw.trim());
  }
  const keys = [...firstSeen.keys()];
  const keywords = [...firstSeen.values()];
  if (keys.length === 0) throw new AppError("VALIDATION_ERROR", "Every keyword was blank, so nothing was saved");
  const tags = [...new Set((input.tags ?? []).map((t) => t.trim()).filter(Boolean))];
  const metrics = new Map((input.metrics ?? []).map((m) => [normKeyword(m.keyword), m]));

  tx(ctx.db, () => {
    const tagIds: string[] = [];
    for (const name of tags) {
      const found = ctx.db.prepare("SELECT id FROM saved_keyword_tags WHERE project_id=? AND name=? COLLATE NOCASE").get(projectId, name) as { id: string } | undefined;
      if (found) tagIds.push(found.id);
      else {
        const id = newId();
        ctx.db.prepare("INSERT INTO saved_keyword_tags (id,project_id,name) VALUES (?,?,?)").run(id, projectId, name);
        tagIds.push(id);
      }
    }
    for (const kw of keys) {
      // Without explicit metrics, reuse what research stored for this keyword and market.
      const stored = ctx.db.prepare("SELECT search_volume, cpc, competition, keyword_difficulty, intent, monthly_searches FROM keyword_metrics WHERE project_id=? AND keyword=? AND location_code=? AND language_code=?").get(projectId, kw, locationCode, languageCode) as
        | { search_volume: number | null; cpc: number | null; competition: number | null; keyword_difficulty: number | null; intent: string | null; monthly_searches: string | null } | undefined;
      const m: KeywordMetricsInput | undefined = metrics.get(kw) ?? (stored ? {
        keyword: kw, searchVolume: stored.search_volume, cpc: stored.cpc, competition: stored.competition, keywordDifficulty: stored.keyword_difficulty,
        intent: stored.intent === "unknown" ? null : stored.intent, monthlySearches: stored.monthly_searches ? (JSON.parse(stored.monthly_searches) as KeywordMetricsInput["monthlySearches"]) : undefined,
      } : undefined);
      const existing = ctx.db.prepare("SELECT id FROM saved_keywords WHERE project_id=? AND keyword=? AND location_code=? AND language_code=?").get(projectId, kw, locationCode, languageCode) as { id: string } | undefined;
      const id = existing?.id ?? newId();
      if (existing) {
        if (m)
          ctx.db.prepare("UPDATE saved_keywords SET search_volume=?, keyword_difficulty=?, cpc=?, competition=?, intent=?, monthly_searches=? WHERE id=?")
            .run(m.searchVolume ?? null, m.keywordDifficulty ?? null, m.cpc ?? null, m.competition ?? null, m.intent ?? null, m.monthlySearches ? JSON.stringify(m.monthlySearches) : null, id);
      } else {
        ctx.db.prepare("INSERT INTO saved_keywords (id,project_id,keyword,location_code,language_code,search_volume,keyword_difficulty,cpc,competition,intent,monthly_searches,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(id, projectId, kw, locationCode, languageCode, m?.searchVolume ?? null, m?.keywordDifficulty ?? null, m?.cpc ?? null, m?.competition ?? null, m?.intent ?? null, m?.monthlySearches ? JSON.stringify(m.monthlySearches) : null, nowIso());
      }
      if (tagMode === "replace" && tags.length > 0) ctx.db.prepare("DELETE FROM saved_keyword_tag_assignments WHERE saved_keyword_id=?").run(id);
      for (const t of tagIds) ctx.db.prepare("INSERT OR IGNORE INTO saved_keyword_tag_assignments (saved_keyword_id,tag_id) VALUES (?,?)").run(id, t);
    }
  });
  return { projectId, savedCount: keys.length, keywords, tags, tagMode, locationCode, languageCode };
}

export function listSavedKeywords(
  ctx: Ctx,
  projectId: string,
  opts: { search?: string; tags?: string[]; limit?: number } = {},
) {
  getProject(ctx, projectId);
  const limit = opts.limit ?? 100;
  const where = ["k.project_id = ?"];
  const args: (string | number)[] = [projectId];
  if (opts.search) {
    where.push("k.keyword LIKE ? ESCAPE '\\'");
    args.push(`%${opts.search.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`);
  }
  if (opts.tags?.length) {
    where.push(`EXISTS (SELECT 1 FROM saved_keyword_tag_assignments a JOIN saved_keyword_tags t ON t.id=a.tag_id
      WHERE a.saved_keyword_id=k.id AND t.name COLLATE NOCASE IN (${opts.tags.map(() => "?").join(",")}))`);
    args.push(...opts.tags);
  }
  const w = where.join(" AND ");
  const totalCount = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM saved_keywords k WHERE ${w}`).get(...args) as { n: number }).n;
  const rows = (ctx.db.prepare(`SELECT k.* FROM saved_keywords k WHERE ${w} ORDER BY k.search_volume IS NULL, k.search_volume DESC, k.keyword LIMIT ?`).all(...args, limit) as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    keyword: r.keyword as string,
    searchVolume: r.search_volume as number | null,
    keywordDifficulty: r.keyword_difficulty as number | null,
    cpc: r.cpc as number | null,
    competition: r.competition as number | null,
    intent: r.intent as string | null,
    tags: (ctx.db.prepare("SELECT t.name FROM saved_keyword_tag_assignments a JOIN saved_keyword_tags t ON t.id=a.tag_id WHERE a.saved_keyword_id=? ORDER BY t.name COLLATE NOCASE").all(r.id as string) as { name: string }[]).map((t) => t.name),
  }));
  const tags = ctx.db.prepare(
    `SELECT t.name AS name, COUNT(a.saved_keyword_id) AS keywordCount FROM saved_keyword_tags t
     LEFT JOIN saved_keyword_tag_assignments a ON a.tag_id=t.id WHERE t.project_id=? GROUP BY t.id ORDER BY t.name COLLATE NOCASE`,
  ).all(projectId) as { name: string; keywordCount: number }[];
  return { rows, totalCount, tags: tags.map((t) => ({ name: t.name, keywordCount: Number(t.keywordCount) })) };
}

export function removeSavedKeywords(ctx: Ctx, projectId: string, ids: string[]) {
  getProject(ctx, projectId);
  let deleted = 0;
  tx(ctx.db, () => {
    for (const id of new Set(ids)) {
      deleted += Number(ctx.db.prepare("DELETE FROM saved_keywords WHERE id=? AND project_id=?").run(id, projectId).changes);
    }
  });
  return { projectId, requested: ids.length, deletedCount: deleted };
}
