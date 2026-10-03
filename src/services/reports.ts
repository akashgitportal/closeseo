import { randomBytes } from "node:crypto";
import type { Ctx } from "../ctx.ts";
import { newId, nowIso } from "../db.ts";
import { AppError } from "../errors.ts";
import { getProject } from "./projects.ts";

const MAX_HTML_BYTES = 500_000;
const MAX_REPORTS = 10_000;
const MAX_TITLE_CHARS = 120;
const MAX_SUMMARY_CHARS = 2_500;
const fmt = (n: number) => n.toLocaleString("en-US");
const kbUp = (b: number) => `${fmt(Math.ceil(b / 1000))} KB`;
const kbDown = (b: number) => `${fmt(Math.floor(b / 1000))} KB`;
const MAX_TEMPLATES = 10;
const PREVIEW_CHARS = 200;

type ReportRow = {
  id: string; project_id: string; title: string; summary: string; html: string; skill: string | null;
  template_id: string | null; share_token: string | null; created_at: string; updated_at: string; created_by: string; created_by_user_id: string;
};

export const reportUrl = (base: string, projectId: string, id: string) => `${base}/p/${projectId}/reports/${id}`;
export const shareUrlFor = (base: string, token: string | null) => (token ? `${base}/s/${token}` : null);

function row(ctx: Ctx, projectId: string, id: string, message = "NOT_FOUND"): ReportRow {
  const r = ctx.db.prepare("SELECT * FROM reports WHERE id=? AND project_id=?").get(id, projectId) as ReportRow | undefined;
  if (!r) throw new AppError("NOT_FOUND", message);
  return r;
}

const sizeOf = (r: ReportRow) => Buffer.byteLength(r.html);
function meta(r: ReportRow) {
  return {
    id: r.id, projectId: r.project_id, title: r.title, summary: r.summary, skill: r.skill, templateId: r.template_id,
    createdBy: r.created_by, createdByUserId: r.created_by_user_id, sizeBytes: sizeOf(r), createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function present(r: ReportRow, base: string, includeHtml: boolean) {
  return { ...meta(r), htmlBytes: sizeOf(r), url: reportUrl(base, r.project_id, r.id), shareUrl: shareUrlFor(base, r.share_token), ...(includeHtml ? { html: r.html } : {}) };
}

export function saveReport(
  ctx: Ctx, projectId: string, base: string,
  i: { title: string; summary: string; html: string; reportId?: string; skill?: string; templateId?: string },
  createdBy = "app",
) {
  getProject(ctx, projectId);
  const title = i.title;
  if (title.length > MAX_TITLE_CHARS) throw new AppError("VALIDATION_ERROR", `Title is ${fmt(title.length)} characters; the limit is ${fmt(MAX_TITLE_CHARS)}. Shorten it and save again.`);
  if (i.summary.length > MAX_SUMMARY_CHARS) throw new AppError("VALIDATION_ERROR", `Summary is ${fmt(i.summary.length)} characters; the limit is ${fmt(MAX_SUMMARY_CHARS)}. Shorten it and save again.`);
  const bytes = Buffer.byteLength(i.html);
  if (bytes > MAX_HTML_BYTES) throw new AppError("VALIDATION_ERROR", `Report is ${kbUp(bytes)}; the limit is ${kbDown(MAX_HTML_BYTES)}. Inlined images are the usual cause. Remove them and save again.`);
  // A cheap structural check: models sometimes stop mid-document, and updating in place would destroy the last good report.
  const trimmed = i.html.trim().toLowerCase();
  if (!trimmed.includes("<html") || !trimmed.endsWith("</html>"))
    throw new AppError("VALIDATION_ERROR", "The HTML has no closing </html>; the model stopped early. On Codex, escape backticks and ${.");
  if (i.templateId && !ctx.db.prepare("SELECT 1 FROM report_templates WHERE id=? AND project_id=?").get(i.templateId, projectId))
    throw new AppError("NOT_FOUND", `No report template ${i.templateId} in this project. Call list_report_templates to see what exists.`);
  const existing = i.reportId ? row(ctx, projectId, i.reportId, `No report ${i.reportId} in this project. Call list_reports, or omit reportId to create a new one.`) : null;
  // Titles are unique within a project, which keeps the duplicate pointer unambiguous.
  const clash = ctx.db.prepare("SELECT id, title FROM reports WHERE project_id=? AND title=?").get(projectId, title) as { id: string; title: string } | undefined;
  if (clash && clash.id !== existing?.id) throw new AppError("VALIDATION_ERROR", `A report titled '${clash.title}' exists (id ${clash.id}). Pass reportId to update it, or change the title.`);
  const now = nowIso();
  if (i.reportId) {
    ctx.db.prepare("UPDATE reports SET title=?, summary=?, html=?, skill=COALESCE(?,skill), template_id=COALESCE(?,template_id), updated_at=? WHERE id=?")
      .run(title, i.summary, i.html, i.skill ?? null, i.templateId ?? null, now, i.reportId);
    return { reportId: i.reportId, title, created: false, htmlBytes: bytes, url: reportUrl(base, projectId, i.reportId) };
  }
  const n = Number((ctx.db.prepare("SELECT COUNT(*) AS n FROM reports WHERE project_id=?").get(projectId) as { n: number }).n);
  if (n >= MAX_REPORTS) throw new AppError("VALIDATION_ERROR", `This project has ${fmt(MAX_REPORTS)} reports, the limit. Delete one from the Reports page.`);
  const id = newId();
  ctx.db.prepare("INSERT INTO reports (id,project_id,title,summary,html,skill,template_id,created_at,updated_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, projectId, title, i.summary, i.html, i.skill ?? null, i.templateId ?? null, now, now, createdBy);
  return { reportId: id, title, created: true, htmlBytes: bytes, url: reportUrl(base, projectId, id) };
}

export function listReports(ctx: Ctx, projectId: string, base: string, i: { limit?: number; offset?: number }) {
  getProject(ctx, projectId);
  const limit = Math.min(50, Math.max(1, i.limit ?? 20)), offset = Math.max(0, i.offset ?? 0);
  const totalCount = Number((ctx.db.prepare("SELECT COUNT(*) AS n FROM reports WHERE project_id=?").get(projectId) as { n: number }).n);
  const rows = ctx.db.prepare("SELECT * FROM reports WHERE project_id=? ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?").all(projectId, limit, offset) as ReportRow[];
  return { reports: rows.map(meta), totalCount, rowCount: rows.length, remaining: Math.max(0, MAX_REPORTS - totalCount) };
}

const notFoundMsg = (id: string) => `No report ${id} in this project. Call list_reports to see what exists.`;
export function getReport(ctx: Ctx, projectId: string, base: string, i: { reportId: string; includeHtml?: boolean }) {
  getProject(ctx, projectId);
  return { report: present(row(ctx, projectId, i.reportId, notFoundMsg(i.reportId)), base, Boolean(i.includeHtml)) };
}

export function setReportSharing(ctx: Ctx, projectId: string, base: string, i: { reportId: string; public: boolean }) {
  const r = row(ctx, projectId, i.reportId, notFoundMsg(i.reportId));
  if (i.public && !ctx.config.enablePublicSharing) throw new AppError("VALIDATION_ERROR", "Public sharing is disabled on this server. Set ENABLE_PUBLIC_SHARING=1 to allow share links.");
  let token = r.share_token;
  if (i.public && !token) token = randomBytes(24).toString("base64url");
  if (!i.public) token = null;
  if (token !== r.share_token) ctx.db.prepare("UPDATE reports SET share_token=? WHERE id=?").run(token, r.id);
  return { reportId: r.id, public: token !== null, url: reportUrl(base, projectId, r.id), shareUrl: shareUrlFor(base, token) };
}

export function deleteReport(ctx: Ctx, projectId: string, i: { reportId: string }) {
  row(ctx, projectId, i.reportId, notFoundMsg(i.reportId));
  ctx.db.prepare("DELETE FROM reports WHERE id=?").run(i.reportId);
  return { reportId: i.reportId, deleted: true as const };
}

export function getSharedReport(ctx: Ctx, token: string): { title: string; html: string } | null {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const r = ctx.db.prepare("SELECT title, html FROM reports WHERE share_token=?").get(token) as { title: string; html: string } | undefined;
  return r ?? null;
}

export function listReportTemplates(ctx: Ctx, projectId: string) {
  getProject(ctx, projectId);
  const rows = ctx.db.prepare("SELECT id, name, description, instructions, updated_at FROM report_templates WHERE project_id=? ORDER BY name").all(projectId) as { id: string; name: string; description: string; instructions: string; updated_at: string }[];
  const templates = rows.map((t) => ({ id: t.id, name: t.name, description: t.description, instructionsPreview: t.instructions.length > PREVIEW_CHARS ? `${t.instructions.slice(0, PREVIEW_CHARS)}…` : t.instructions, updatedAt: t.updated_at }));
  return { templates, remaining: Math.max(0, MAX_TEMPLATES - rows.length) };
}

export function saveReportTemplate(ctx: Ctx, projectId: string, base: string, i: { templateId?: string; name: string; description: string; instructions: string }) {
  getProject(ctx, projectId);
  const name = i.name.trim();
  if (!name || name.length > 120) throw new AppError("VALIDATION_ERROR", "Template name must be 1-120 characters");
  const url = `${base}/p/${projectId}/reports/templates`;
  const now = nowIso();
  if (i.templateId) {
    if (!ctx.db.prepare("SELECT 1 FROM report_templates WHERE id=? AND project_id=?").get(i.templateId, projectId)) throw new AppError("NOT_FOUND", `No report template ${i.templateId} in this project. Call list_report_templates to see what exists.`);
    ctx.db.prepare("UPDATE report_templates SET name=?, description=?, instructions=?, updated_at=? WHERE id=?").run(name, i.description, i.instructions, now, i.templateId);
    return { templateId: i.templateId, name, created: false, url };
  }
  const n = Number((ctx.db.prepare("SELECT COUNT(*) AS n FROM report_templates WHERE project_id=?").get(projectId) as { n: number }).n);
  if (n >= MAX_TEMPLATES) throw new AppError("VALIDATION_ERROR", `This project has ${MAX_TEMPLATES} report templates, the limit. Delete one first.`);
  const id = newId();
  ctx.db.prepare("INSERT INTO report_templates (id,project_id,name,description,instructions,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, projectId, name, i.description, i.instructions, now, now);
  return { templateId: id, name, created: true, url };
}

export function deleteReportTemplate(ctx: Ctx, projectId: string, i: { templateId: string }) {
  getProject(ctx, projectId);
  const r = ctx.db.prepare("DELETE FROM report_templates WHERE id=? AND project_id=?").run(i.templateId, projectId);
  if (Number(r.changes) === 0) throw new AppError("NOT_FOUND", `No report template ${i.templateId} in this project. Call list_report_templates to see what exists.`);
  return { templateId: i.templateId, deleted: true as const };
}
