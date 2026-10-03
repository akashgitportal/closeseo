import type { Ctx } from "../ctx.ts";
import { newId, nowIso, tx } from "../db.ts";
import { normalizeDomain } from "../domain-utils.ts";
import { AppError } from "../errors.ts";
import { getProject } from "./projects.ts";

export const STANDARD_SECTIONS = [
  "business_overview",
  "current_goal",
  "positioning",
  "writing_preferences",
] as const;
const MAX_SECTION_CHARS = 4000;
export type Actor = "mcp" | "user";
const MAX_LIST = 100;

export type ContextUpdate =
  | { section: (typeof STANDARD_SECTIONS)[number]; content: string }
  | { customSection: string; title?: string; content: string }
  | { deleteCustomSection: string }
  | { addCompetitors: { domain: string; name?: string; notes?: string }[] }
  | { removeCompetitors: string[] }
  | { addKeyPages: { url: string; role?: string; topic?: string; notes?: string }[] }
  | { removeKeyPages: string[] }
  | { appendResearchLog: { summary: string } }
  | { removeResearchLog: string[] };

export function getContext(ctx: Ctx, projectId: string) {
  getProject(ctx, projectId);
  const rows = ctx.db
    .prepare("SELECT slug, kind, title, content, updated_at, updated_by FROM context_sections WHERE project_id=?")
    .all(projectId) as { slug: string; kind: string; title: string | null; content: string; updated_at: string; updated_by: string }[];
  const sections = STANDARD_SECTIONS.flatMap((key) => {
    const r = rows.find((x) => x.kind === "standard" && x.slug === key);
    return r ? [{ key, content: r.content, updatedAt: r.updated_at, updatedBy: r.updated_by }] : [];
  });
  const have = new Set(sections.map((s) => s.key));
  return {
    sections,
    missingSections: STANDARD_SECTIONS.filter((s) => !have.has(s)),
    customSections: rows
      .filter((r) => r.kind === "custom")
      .sort((x, y) => (x.slug < y.slug ? -1 : 1))
      .map((r) => ({ slug: r.slug, title: r.title, content: r.content, updatedAt: r.updated_at, updatedBy: r.updated_by })),
    competitors: (
      ctx.db.prepare("SELECT id, domain, note, updated_at, updated_by FROM context_competitors WHERE project_id=? ORDER BY domain").all(projectId) as {
        id: string; domain: string; note: string | null; updated_at: string; updated_by: string;
      }[]
    ).map((c) => {
      const meta = parseNote(c.note);
      return { id: c.id, projectId, domain: c.domain, name: meta.name ?? null, notes: meta.notes ?? null, updatedAt: c.updated_at, updatedBy: c.updated_by };
    }),
    keyPages: (
      ctx.db.prepare("SELECT id, url, note, updated_at, updated_by FROM context_key_pages WHERE project_id=? ORDER BY url").all(projectId) as {
        id: string; url: string; note: string | null; updated_at: string; updated_by: string;
      }[]
    ).map((p) => {
      const meta = parseNote(p.note);
      return { id: p.id, projectId, url: p.url, role: meta.role ?? "other", topic: meta.topic ?? null, notes: meta.notes ?? null, updatedAt: p.updated_at, updatedBy: p.updated_by };
    }),
    researchLog: (
      ctx.db.prepare("SELECT id, note, created_at, created_by FROM context_research_log WHERE project_id=? ORDER BY created_at, rowid").all(projectId) as {
        id: string; note: string; created_at: string; created_by: string;
      }[]
    ).map((r) => ({ id: r.id, entryDate: r.created_at.slice(0, 10), summary: r.note, createdBy: r.created_by })),
    reportTemplates: (
      ctx.db.prepare("SELECT id, name, description FROM report_templates WHERE project_id=? ORDER BY name").all(projectId) as Record<string, unknown>[]
    ),
  };
}

function parseNote(note: string | null): Record<string, string | undefined> {
  if (!note) return {};
  try {
    return JSON.parse(note) as Record<string, string | undefined>;
  } catch {
    return { notes: note };
  }
}

function checkContent(content: string) {
  if (content.length > MAX_SECTION_CHARS)
    throw new AppError("VALIDATION_ERROR", `Sections are capped at ${MAX_SECTION_CHARS} characters. Summarize instead of pasting.`);
}

function count(ctx: Ctx, table: string, projectId: string): number {
  return (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id=?`).get(projectId) as { n: number }).n;
}

export function updateContext(ctx: Ctx, projectId: string, updates: ContextUpdate[], actor: Actor = "mcp") {
  getProject(ctx, projectId);
  tx(ctx.db, () => {
    for (const [index, u] of updates.entries()) {
      try {
      if ("section" in u) {
        checkContent(u.content);
        upsertSection(ctx, projectId, u.section, "standard", null, u.content, actor);
      } else if ("customSection" in u) {
        checkContent(u.content);
        const existing = ctx.db.prepare("SELECT title FROM context_sections WHERE project_id=? AND slug=? AND kind='custom'").get(projectId, u.customSection) as { title: string | null } | undefined;
        upsertSection(ctx, projectId, u.customSection, "custom", u.title ?? existing?.title ?? null, u.content, actor);
      } else if ("deleteCustomSection" in u) {
        ctx.db.prepare("DELETE FROM context_sections WHERE project_id=? AND slug=? AND kind='custom'").run(projectId, u.deleteCustomSection);
      } else if ("addCompetitors" in u) {
        for (const c of u.addCompetitors) {
          const domain = normalizeDomain(c.domain);
          if (count(ctx, "context_competitors", projectId) >= MAX_LIST && !ctx.db.prepare("SELECT 1 FROM context_competitors WHERE project_id=? AND domain=?").get(projectId, domain))
            throw new AppError("VALIDATION_ERROR", `At most ${MAX_LIST} competitors per project`);
          ctx.db.prepare(
            `INSERT INTO context_competitors (id,project_id,domain,note,updated_at,updated_by) VALUES (?,?,?,?,?,?)
             ON CONFLICT(project_id,domain) DO UPDATE SET note=excluded.note, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
          ).run(newId(), projectId, domain, JSON.stringify({ name: c.name, notes: c.notes }), nowIso(), actor);
        }
      } else if ("removeCompetitors" in u) {
        for (const d of u.removeCompetitors) {
          let key = d;
          try { key = normalizeDomain(d); } catch { /* treat as id */ }
          ctx.db.prepare("DELETE FROM context_competitors WHERE project_id=? AND (domain=? OR id=?)").run(projectId, key, d);
        }
      } else if ("addKeyPages" in u) {
        for (const p of u.addKeyPages) {
          if (count(ctx, "context_key_pages", projectId) >= MAX_LIST && !ctx.db.prepare("SELECT 1 FROM context_key_pages WHERE project_id=? AND url=?").get(projectId, p.url))
            throw new AppError("VALIDATION_ERROR", `At most ${MAX_LIST} key pages per project`);
          ctx.db.prepare(
            `INSERT INTO context_key_pages (id,project_id,url,note,updated_at,updated_by) VALUES (?,?,?,?,?,?)
             ON CONFLICT(project_id,url) DO UPDATE SET note=excluded.note, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
          ).run(newId(), projectId, p.url, JSON.stringify({ role: p.role, topic: p.topic, notes: p.notes }), nowIso(), actor);
        }
      } else if ("removeKeyPages" in u) {
        for (const x of u.removeKeyPages)
          ctx.db.prepare("DELETE FROM context_key_pages WHERE project_id=? AND (url=? OR id=?)").run(projectId, x, x);
      } else if ("appendResearchLog" in u) {
        ctx.db.prepare("INSERT INTO context_research_log (id,project_id,note,created_at,created_by) VALUES (?,?,?,?,?)").run(newId(), projectId, u.appendResearchLog.summary, nowIso(), actor);
      } else if ("removeResearchLog" in u) {
        for (const id of u.removeResearchLog)
          ctx.db.prepare("DELETE FROM context_research_log WHERE project_id=? AND id=?").run(projectId, id);
      }
      } catch (e) {
        if (e instanceof AppError && e.code === "VALIDATION_ERROR")
          throw new AppError("VALIDATION_ERROR", `updates[${index}] was rejected (nothing in this batch was applied): ${e.message}`);
        throw e;
      }
    }
  });
  return getContext(ctx, projectId);
}

function upsertSection(ctx: Ctx, projectId: string, slug: string, kind: string, title: string | null, content: string, actor: Actor) {
  // Empty content clears the section (patch semantics).
  if (content.trim() === "") {
    ctx.db.prepare("DELETE FROM context_sections WHERE project_id=? AND slug=?").run(projectId, slug);
    return;
  }
  ctx.db.prepare(
    `INSERT INTO context_sections (project_id,slug,kind,title,content,updated_at,updated_by) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(project_id,slug) DO UPDATE SET kind=excluded.kind, title=excluded.title, content=excluded.content, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
  ).run(projectId, slug, kind, title, content, nowIso(), actor);
}
