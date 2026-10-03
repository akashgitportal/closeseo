import type { Ctx } from "../ctx.ts";
import { AppError } from "../errors.ts";
import { getContext, updateContext, type ContextUpdate } from "../services/context.ts";
import { createProject, listProjects } from "../services/projects.ts";
import { getKeywordMetrics, researchKeywords } from "../services/keywords.ts";
import { listSavedKeywords, removeSavedKeywords, saveKeywords } from "../services/savedKeywords.ts";
import { findSerpCompetitors, getDomainKeywordSuggestions, getDomainOverview, getRankedKeywords } from "../services/domain.ts";
import { getBacklinksOverview, getBacklinksProfile } from "../services/backlinks.ts";
import { getSerpResults, searchSerpLocations } from "../services/serp.ts";
import {
  addRankTrackingKeywords, createRankTracker, estimateRankTrackerCost, getRankTracker,
  removeRankTrackingKeywords, runRankTracker,
} from "../services/rankTracking.ts";
import {
  getBusinessProfile, getBusinessReviews, getBusinessUpdates, getGoogleBusinessQuestions, getLocalRankGrid, getLocalSerpResults,
  listBusinessCategories, searchLocalBusinesses,
} from "../services/local.ts";
import { ga4Handlers, gscHandlers } from "./google-tools.ts";
import { deleteAudit, getAuditIssues, getAuditPages, getAuditStatus, listAudits, startAudit } from "../services/audit.ts";
import {
  deleteReport, deleteReportTemplate, getReport, listReports, listReportTemplates, saveReport,
  saveReportTemplate, setReportSharing,
} from "../services/reports.ts";

export type ToolEnv = { baseUrl: string; clientLabel?: string };
export type ToolResult = { data: Record<string, unknown>; text: string; url?: string };
type Args = Record<string, any>;
type Handler = (ctx: Ctx, a: Args, env: ToolEnv) => ToolResult | Promise<ToolResult>;

const projectUrl = (env: ToolEnv, id: string, path = "", query?: Record<string, string | undefined>) => {
  const qs = Object.entries(query ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
  return `${env.baseUrl}/p/${id}${path}${qs ? `?${qs}` : ""}`;
};
const json = (v: unknown, max = 20_000) => {
  const s = JSON.stringify(v, null, 1);
  return s.length > max ? `${s.slice(0, max)}\n… (truncated; see structuredContent)` : s;
};

/** Integrations that may need extra provider access and are not part of this release. */
const UNSUPPORTED_REASON: Record<string, string> = {
  local: "Google Business / local SEO data tools",
};
const unsupported = (kind: keyof typeof UNSUPPORTED_REASON): Handler => {
  const h: Handler & { unsupported?: true } = () => {
    throw new AppError("NOT_CONFIGURED", `${UNSUPPORTED_REASON[kind]} is not available in this release of closeseo.`);
  };
  h.unsupported = true;
  return h;
};

export const HANDLERS: Record<string, Handler> = {
  ...gscHandlers,
  ...ga4Handlers,
  whoami: (ctx) => ({
    data: { userEmail: "admin@localhost", scopes: [], mode: "self-hosted", creditsRemaining: null },
    text: `Signed in as ${ctx.config.authMode === "local_noauth" ? "admin@localhost (no login required)" : "the API-key user"}.\nThis is a self-hosted closeseo server; there are no token scopes.`,
  }),

  list_projects: (ctx, _a, env) => {
    const projects = listProjects(ctx).map((p) => ({ ...p, url: projectUrl(env, p.id) }));
    return {
      data: { projects },
      url: `${env.baseUrl}/`,
      text: `${projects.length} project${projects.length === 1 ? "" : "s"}:\n${projects.map((p) => `* ${p.name} [${p.id}] site: ${p.domain ?? "none"}, market ${p.locationCode}/${p.languageCode}`).join("\n")}`,
    };
  },
  create_project: (ctx, a, env) => {
    if (a.organizationId !== undefined) throw new AppError("VALIDATION_ERROR", "organizationId cannot be used here: closeseo has a single owner and no organisations");
    const p = createProject(ctx, a as never);
    const url = projectUrl(env, p.id);
    return { data: { project: { ...p, url } }, url, text: `Project "${p.name}" created with id ${p.id} (site: ${p.domain ?? "none"}, market ${p.locationCode}/${p.languageCode}).` };
  },
  get_project_context: (ctx, a, env) => ({ data: getContext(ctx, a.projectId), url: projectUrl(env, a.projectId, "/context"), text: "Returned the project's saved notes, competitors, key pages and research log." }),
  update_project_context: (ctx, a, env) => ({
    data: updateContext(ctx, a.projectId, a.updates as ContextUpdate[]), url: projectUrl(env, a.projectId, "/context"),
    text: `Saved ${a.updates.length} change${a.updates.length === 1 ? "" : "s"} to the project notes.`,
  }),

  list_saved_keywords: (ctx, a, env) => {
    const r = listSavedKeywords(ctx, a.projectId, a);
    return { data: r, url: projectUrl(env, a.projectId, "/saved"), text: `The project has ${r.totalCount} saved keyword${r.totalCount === 1 ? "" : "s"}; ${r.rows.length} listed.\n${r.rows.map((k) => `* ${k.keyword} (volume ${k.searchVolume ?? "n/a"}, difficulty ${k.keywordDifficulty ?? "n/a"}) tags: ${k.tags.join(", ") || "none"}`).join("\n")}` };
  },
  save_keywords: (ctx, a, env) => {
    const r = saveKeywords(ctx, a.projectId, a as never);
    return { data: r, url: projectUrl(env, a.projectId, "/saved"), text: `${r.savedCount} keyword${r.savedCount === 1 ? "" : "s"} saved.` };
  },
  remove_saved_keywords: (ctx, a, env) => {
    const r = removeSavedKeywords(ctx, a.projectId, a.savedKeywordIds);
    return { data: r, url: projectUrl(env, a.projectId, "/saved"), text: `Deleted ${r.deletedCount} of the ${r.requested} saved keyword${r.requested === 1 ? "" : "s"} you named.` };
  },

  research_keywords: async (ctx, a, env) => {
    const r = await researchKeywords(ctx, a.projectId, a as never);
    const lines = r.results.map((x) => (x.ok ? `Seed "${x.seed}": ${x.rowCount} keywords from ${x.source}${x.usedFallback ? " plus related-keyword fill-in" : ""}` : `Seed "${x.seed}" failed: ${x.error}`));
    return { data: r, url: projectUrl(env, a.projectId, "/keywords"), text: `${lines.join("\n")}\n${json(r.results.filter((x) => x.ok).map((x) => (x.ok ? { seed: x.seed, rows: x.rows.slice(0, 50) } : null)), 12_000)}` };
  },
  get_keyword_metrics: async (ctx, a, env) => {
    const r = await getKeywordMetrics(ctx, a.projectId, a as never);
    return { data: r, url: projectUrl(env, a.projectId, "/keywords"), text: `Metrics for ${r.keywords.length} keyword${r.keywords.length === 1 ? "" : "s"}:\n${json(r.keywords)}` };
  },

  get_domain_overview: async (ctx, a, env) => {
    const r = await getDomainOverview(ctx, a.projectId, a as never);
    const note = r.scope === "subdomains" ? [] : ["These totals describe the whole domain with its subdomains. For numbers limited to your chosen scope, call get_ranked_keywords."];
    return {
      data: r, url: projectUrl(env, a.projectId, "/domain", { domain: a.domain }),
      text: [`Overview of ${r.displayTarget} (scope ${r.scope})`, `estimated organic traffic: ${r.organicTraffic ?? "unknown"}`, `ranking keywords: ${r.organicKeywords ?? "unknown"}`, `backlinks: ${r.backlinks ?? "unknown"}`, `referring domains: ${r.referringDomains ?? "unknown"}`, ...note].join("\n"),
    };
  },
  get_domain_keyword_suggestions: async (ctx, a, env) => {
    const r = await getDomainKeywordSuggestions(ctx, a.projectId, a as never);
    return { data: r, url: projectUrl(env, a.projectId, "/domain", { domain: r.target, scope: r.scope }), text: `${r.target} (scope ${r.scope}) ranks for ${r.keywords.length} keyword${r.keywords.length === 1 ? "" : "s"} on this page of results:\n${json(r.keywords.slice(0, 50))}` };
  },
  get_ranked_keywords: async (ctx, a, env) => {
    const r = await getRankedKeywords(ctx, a.projectId, a as never);
    return {
      data: r, url: projectUrl(env, a.projectId, "/domain", { domain: r.target, scope: r.scope }),
      text: r.keywords.length === 0 ? `${r.target} (scope ${r.scope}) has no ranking keywords matching these filters.` : `${r.target} (scope ${r.scope}): showing ${r.keywords.length}${r.totalCount != null ? ` of ${r.totalCount}` : ""} ranking keywords:\n${json(r.keywords.slice(0, 50))}`,
    };
  },
  find_serp_competitors: async (ctx, a, env) => {
    const r = await findSerpCompetitors(ctx, a.projectId, a as never);
    return { data: r, url: projectUrl(env, a.projectId, "/domain"), text: `${r.competitors.length} domain${r.competitors.length === 1 ? "" : "s"} compete for your ${a.keywords.length} keyword${a.keywords.length === 1 ? "" : "s"}:\n${json(r.competitors)}` };
  },
  get_backlinks_overview: async (ctx, a, env) => {
    const r = await getBacklinksOverview(ctx, a.projectId, a as never);
    const s = r.overview.overview.summary;
    return {
      data: r, url: projectUrl(env, a.projectId, "/backlinks", { target: a.target, scope: r.scope }),
      text: [`Backlink summary for ${r.target} (scope ${r.scope})`, ...(r.scopeNote ? [r.scopeNote] : []), `backlinks: ${s.backlinks ?? "unknown"}`, `referring domains: ${s.referringDomains ?? "unknown"}`, `referring pages: ${s.referringPages ?? "unknown"}`, `domain rank: ${s.rank ?? "unknown"}`].join("\n"),
    };
  },
  get_backlinks_profile: async (ctx, a, env) => {
    const r = await getBacklinksProfile(ctx, a.projectId, a as never);
    return { data: r, url: projectUrl(env, a.projectId, "/backlinks", { target: a.target, scope: r.scope }), text: `${r.target} has ${r.backlinks.totalCount ?? "an unknown number of"} backlinks; this is page ${r.backlinks.page}:\n${json(r.backlinks.rows.slice(0, 50))}` };
  },
  get_serp_results: async (ctx, a, env) => {
    const r = await getSerpResults(ctx, a.projectId, a as never);
    const ok = r.results.filter((x) => x.ok).length;
    return {
      data: r, url: projectUrl(env, a.projectId, "/keywords"),
      text: r.results.map((x) => (x.ok ? `Results for "${x.keyword}" (${x.items.length}):\n${x.items.map((i) => `#${i.rank} ${i.domain ?? "no domain"} | ${i.title ?? "no title"} | ${i.url ?? "no url"}`).join("\n")}` : `Lookup for "${x.keyword}" failed: ${x.error}`)).join("\n\n") + `\n\n${ok}/${r.results.length} lookups worked.`,
    };
  },
  search_serp_locations: async (ctx, a) => {
    const r = await searchSerpLocations(ctx, a as never);
    return { data: r, text: r.locations.map((l) => `${l.locationCode}  ${l.locationName} (${l.locationType})`).join("\n") || "No location matched that search." };
  },

  create_rank_tracker: async (ctx, a, env) => {
    const r = await createRankTracker(ctx, a.projectId, a as never);
    return { data: r, url: projectUrl(env, a.projectId, `/rank-tracking/${r.trackerId}`), text: `Rank tracker ${r.trackerId} now follows ${r.config.domain}.` };
  },
  get_rank_tracker: (ctx, a, env) => {
    const r = getRankTracker(ctx, a.projectId, a.trackerId);
    return { data: r, url: projectUrl(env, a.projectId, a.trackerId ? `/rank-tracking/${a.trackerId}` : "/rank-tracking"), text: json(r) };
  },
  add_rank_tracking_keywords: (ctx, a) => {
    const r = addRankTrackingKeywords(ctx, a.projectId, a as never);
    return { data: r, text: `${r.added} of ${r.requested} keyword${r.requested === 1 ? "" : "s"} added to the tracker.` };
  },
  remove_rank_tracking_keywords: (ctx, a) => {
    const r = removeRankTrackingKeywords(ctx, a.projectId, a as never);
    return { data: r, text: `${r.removed} of ${r.requested} keyword${r.requested === 1 ? "" : "s"} taken off the tracker.` };
  },
  estimate_rank_tracker_cost: (ctx, a, env) => {
    const r = estimateRankTrackerCost(ctx, a.projectId, a as never);
    return { data: r, url: projectUrl(env, a.projectId, `/rank-tracking/${a.trackerId}`), text: `${r.totalChecks} rank checks would cost about $${r.costUsd.toFixed(3)} (${r.costCredits} credits).` };
  },
  run_rank_tracker: (ctx, a) => {
    const r = runRankTracker(ctx, a.projectId, a as never);
    return { data: r, text: r.started ? `Rank check ${r.runId} is running.` : `Rank check ${r.blockingRunId} is still running; wait for it to finish.` };
  },

  run_site_audit: (ctx, a, env) => {
    const r = startAudit(ctx, a.projectId, a as never);
    return { data: r, url: projectUrl(env, a.projectId, "/audit"), text: `Site audit ${r.auditId} has begun. Call get_audit_status to follow progress.` };
  },
  list_site_audits: (ctx, a, env) => {
    const r = listAudits(ctx, a.projectId);
    return { data: r, url: projectUrl(env, a.projectId, "/audit"), text: `${r.audits.length} audit${r.audits.length === 1 ? "" : "s"} on record.` };
  },
  delete_site_audit: (ctx, a) => {
    const r = deleteAudit(ctx, a.projectId, a.auditId);
    return { data: r, text: `Audit ${r.auditId} was deleted.` };
  },
  get_audit_status: (ctx, a) => {
    const r = getAuditStatus(ctx, a.projectId, a.auditId);
    const s = r.status;
    return { data: r, text: `Audit ${s.id} is ${s.status}: ${s.pagesCrawled} of ${s.maxPages} pages crawled. Problems found: ${s.issueCounts.critical} critical, ${s.issueCounts.warning} warning, ${s.issueCounts.info} informational.` };
  },
  get_audit_issues: (ctx, a) => {
    const r = getAuditIssues(ctx, a.projectId, a as never);
    return { data: r, text: r.summary.map((s) => `${s.severity.toUpperCase()}: ${s.type} on ${s.count} page${s.count === 1 ? "" : "s"}`).join("\n") || "The audit found no problems." };
  },
  get_audit_pages: (ctx, a) => {
    const r = getAuditPages(ctx, a.projectId, a as never);
    return { data: r, text: `${r.total} crawled page${r.total === 1 ? "" : "s"}:\n${r.pages.slice(0, 50).map((p) => `${p.statusCode ?? "failed"} ${p.url}`).join("\n")}` };
  },

  save_report: (ctx, a, env) => {
    const r = saveReport(ctx, a.projectId, env.baseUrl, a as never, env.clientLabel ?? "mcp");
    return { data: r, url: r.url, text: `Report ${r.reportId} ${r.created ? "created" : "updated"}; open it at ${r.url}` };
  },
  list_reports: (ctx, a, env) => {
    const r = listReports(ctx, a.projectId, env.baseUrl, a);
    return { data: r, url: projectUrl(env, a.projectId, "/reports"), text: `${r.totalCount} saved report${r.totalCount === 1 ? "" : "s"}:\n${r.reports.map((x) => `* ${x.title} [${x.id}]`).join("\n")}` };
  },
  get_report: (ctx, a, env) => {
    const { report: { html, ...report } } = getReport(ctx, a.projectId, env.baseUrl, a as never) as { report: { html?: string } & Record<string, any> };
    // Structured output stays metadata-only; the document itself is delivered in the text block.
    return { data: { report }, url: report.url, text: html !== undefined ? html : `${report.title}\n${report.summary}` };
  },
  set_report_sharing: (ctx, a, env) => {
    const r = setReportSharing(ctx, a.projectId, env.baseUrl, a as never);
    return { data: r, url: r.url, text: r.public ? `The report can be opened by anyone with this link: ${r.shareUrl}` : "The report is private; its share link is switched off." };
  },
  delete_report: (ctx, a, env) => {
    const r = deleteReport(ctx, a.projectId, a as never);
    return { data: r, url: projectUrl(env, a.projectId, "/reports"), text: `Report ${r.reportId} was deleted.` };
  },
  list_report_templates: (ctx, a, env) => {
    const r = listReportTemplates(ctx, a.projectId);
    return { data: r, url: projectUrl(env, a.projectId, "/reports/templates"), text: `${r.templates.length} report template${r.templates.length === 1 ? "" : "s"} available.` };
  },
  save_report_template: (ctx, a, env) => {
    const r = saveReportTemplate(ctx, a.projectId, env.baseUrl, a as never);
    return { data: r, url: r.url, text: `Template ${r.templateId} ${r.created ? "created" : "updated"}.` };
  },
  delete_report_template: (ctx, a, env) => {
    const r = deleteReportTemplate(ctx, a.projectId, a as never);
    return { data: r, url: projectUrl(env, a.projectId, "/reports/templates"), text: `Template ${r.templateId} was deleted.` };
  },

  // --- Not implemented in this release (listed for contract parity) ---
  search_local_businesses: async (ctx, a, env) => ({ ...(await searchLocalBusinesses(ctx, a)), url: projectUrl(env, a.projectId) }),
  get_local_serp_results: async (ctx, a, env) => ({ ...(await getLocalSerpResults(ctx, a)), url: projectUrl(env, a.projectId) }),
  get_google_business_questions: async (ctx, a, env) => ({ ...(await getGoogleBusinessQuestions(ctx, a)), url: projectUrl(env, a.projectId) }),
  get_business_profile: async (ctx, a, env) => ({ ...(await getBusinessProfile(ctx, a)), url: projectUrl(env, a.projectId) }),
  get_business_reviews: async (ctx, a, env) => ({ ...(await getBusinessReviews(ctx, a)), url: projectUrl(env, a.projectId) }),
  get_business_updates: async (ctx, a, env) => ({ ...(await getBusinessUpdates(ctx, a)), url: projectUrl(env, a.projectId) }),
  list_business_categories: async (ctx, a, env) => ({ ...(await listBusinessCategories(ctx, a)), url: projectUrl(env, a.projectId) }),
  get_local_rank_grid: async (ctx, a, env) => ({ ...(await getLocalRankGrid(ctx, a)), url: projectUrl(env, a.projectId) }),
};

export const UNSUPPORTED_TOOLS = Object.entries(HANDLERS)
  .filter(([, h]) => (h as { unsupported?: true }).unsupported)
  .map(([name]) => name);
