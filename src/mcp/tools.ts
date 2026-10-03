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

/** Integrations that exist in the SOURCE product but are not part of this release. */
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
    text: `Account: ${ctx.config.authMode === "local_noauth" ? "admin@localhost" : "api-key user"}\nMode: self-hosted\nScopes: none`,
  }),

  list_projects: (ctx, _a, env) => {
    const projects = listProjects(ctx).map((p) => ({ ...p, url: projectUrl(env, p.id) }));
    return {
      data: { projects },
      url: `${env.baseUrl}/`,
      text: `Projects (${projects.length}):\n${projects.map((p) => `- ${p.id}  ${p.name} (${p.domain ?? "no domain"})  market:${p.locationCode}/${p.languageCode}`).join("\n")}`,
    };
  },
  create_project: (ctx, a, env) => {
    if (a.organizationId !== undefined) throw new AppError("VALIDATION_ERROR", "organizationId is not supported: closeseo is single-tenant");
    const p = createProject(ctx, a as never);
    const url = projectUrl(env, p.id);
    return { data: { project: { ...p, url } }, url, text: `Created project ${p.id}  ${p.name} (${p.domain ?? "no domain"})  market:${p.locationCode}/${p.languageCode}` };
  },
  get_project_context: (ctx, a, env) => ({ data: getContext(ctx, a.projectId), url: projectUrl(env, a.projectId, "/context"), text: "Project context loaded." }),
  update_project_context: (ctx, a, env) => ({
    data: updateContext(ctx, a.projectId, a.updates as ContextUpdate[]), url: projectUrl(env, a.projectId, "/context"),
    text: `Applied ${a.updates.length} update(s) to project context.`,
  }),

  list_saved_keywords: (ctx, a, env) => {
    const r = listSavedKeywords(ctx, a.projectId, a);
    return { data: r, url: projectUrl(env, a.projectId, "/saved"), text: `${r.totalCount} saved keyword(s); showing ${r.rows.length}.\n${r.rows.map((k) => `- ${k.keyword}  vol:${k.searchVolume ?? "-"}  kd:${k.keywordDifficulty ?? "-"}  [${k.tags.join(", ")}]`).join("\n")}` };
  },
  save_keywords: (ctx, a, env) => {
    const r = saveKeywords(ctx, a.projectId, a as never);
    return { data: r, url: projectUrl(env, a.projectId, "/saved"), text: `Saved ${r.savedCount} keyword(s).` };
  },
  remove_saved_keywords: (ctx, a, env) => {
    const r = removeSavedKeywords(ctx, a.projectId, a.savedKeywordIds);
    return { data: r, url: projectUrl(env, a.projectId, "/saved"), text: `Removed ${r.deletedCount} of ${r.requested} saved keyword(s).` };
  },

  research_keywords: async (ctx, a, env) => {
    const r = await researchKeywords(ctx, a.projectId, a as never);
    const lines = r.results.map((x) => (x.ok ? `## "${x.seed}" — ${x.rowCount} keywords (${x.source}${x.usedFallback ? ", with related-keyword top-up" : ""})` : `## "${x.seed}" — FAILED\n${x.error}`));
    return { data: r, url: projectUrl(env, a.projectId, "/keywords"), text: `${lines.join("\n")}\n${json(r.results.filter((x) => x.ok).map((x) => (x.ok ? { seed: x.seed, rows: x.rows.slice(0, 50) } : null)), 12_000)}` };
  },
  get_keyword_metrics: async (ctx, a, env) => {
    const r = await getKeywordMetrics(ctx, a.projectId, a as never);
    return { data: r, url: projectUrl(env, a.projectId, "/keywords"), text: `Fetched metrics for ${r.keywords.length} keywords.\n${json(r.keywords)}` };
  },

  get_domain_overview: async (ctx, a, env) => {
    const r = await getDomainOverview(ctx, a.projectId, a as never);
    const note = r.scope === "subdomains" ? [] : ["Note: overview metrics cover the whole domain including subdomains; use get_ranked_keywords with this scope for scoped keyword data."];
    return {
      data: r, url: projectUrl(env, a.projectId, "/domain", { domain: a.domain }),
      text: [`Target: ${r.displayTarget} (scope: ${r.scope})`, `Organic traffic: ${r.organicTraffic ?? "?"}`, `Organic keywords: ${r.organicKeywords ?? "?"}`, `Backlinks: ${r.backlinks ?? "?"}`, `Referring domains: ${r.referringDomains ?? "?"}`, ...note].join("\n"),
    };
  },
  get_domain_keyword_suggestions: async (ctx, a, env) => {
    const r = await getDomainKeywordSuggestions(ctx, a.projectId, a as never);
    return { data: r, url: projectUrl(env, a.projectId, "/domain", { domain: r.target, scope: r.scope }), text: `${r.keywords.length} ranked keywords for ${r.target} (scope: ${r.scope}).\n${json(r.keywords.slice(0, 50))}` };
  },
  get_ranked_keywords: async (ctx, a, env) => {
    const r = await getRankedKeywords(ctx, a.projectId, a as never);
    return {
      data: r, url: projectUrl(env, a.projectId, "/domain", { domain: r.target, scope: r.scope }),
      text: r.keywords.length === 0 ? `No ranked keyword rows for ${r.target} (scope: ${r.scope}).` : `Found ${r.keywords.length} ranked keyword rows for ${r.target} (scope: ${r.scope})${r.totalCount != null ? ` (of ${r.totalCount} total)` : ""}:\n${json(r.keywords.slice(0, 50))}`,
    };
  },
  find_serp_competitors: async (ctx, a, env) => {
    const r = await findSerpCompetitors(ctx, a.projectId, a as never);
    return { data: r, url: projectUrl(env, a.projectId, "/domain"), text: `Found ${r.competitors.length} SERP competitors across ${a.keywords.length} keywords.\n${json(r.competitors)}` };
  },
  get_backlinks_overview: async (ctx, a, env) => {
    const r = await getBacklinksOverview(ctx, a.projectId, a as never);
    const s = r.overview.overview.summary;
    return {
      data: r, url: projectUrl(env, a.projectId, "/backlinks", { target: a.target, scope: r.scope }),
      text: [`Backlinks profile for ${r.target} (scope: ${r.scope}):`, ...(r.scopeNote ? [`Note: ${r.scopeNote}`] : []), `- backlinks: ${s.backlinks ?? "?"}`, `- referring domains: ${s.referringDomains ?? "?"}`, `- referring pages: ${s.referringPages ?? "?"}`, `- rank: ${s.rank ?? "?"}`].join("\n"),
    };
  },
  get_backlinks_profile: async (ctx, a, env) => {
    const r = await getBacklinksProfile(ctx, a.projectId, a as never);
    return { data: r, url: projectUrl(env, a.projectId, "/backlinks", { target: a.target, scope: r.scope }), text: `${r.backlinks.totalCount ?? "?"} backlinks for ${r.target} (page ${r.backlinks.page}).\n${json(r.backlinks.rows.slice(0, 50))}` };
  },
  get_serp_results: async (ctx, a, env) => {
    const r = await getSerpResults(ctx, a.projectId, a as never);
    const ok = r.results.filter((x) => x.ok).length;
    return {
      data: r, url: projectUrl(env, a.projectId, "/keywords"),
      text: r.results.map((x) => (x.ok ? `"${x.keyword}" (${x.items.length} results):\n${x.items.map((i) => `${i.rank} | ${i.domain ?? "—"} | ${i.title ?? "—"} | ${i.url ?? "—"}`).join("\n")}` : `"${x.keyword}": FAILED — ${x.error}`)).join("\n\n") + `\n\n${ok} of ${r.results.length} queries succeeded.`,
    };
  },
  search_serp_locations: async (ctx, a) => {
    const r = await searchSerpLocations(ctx, a as never);
    return { data: r, text: r.locations.map((l) => `${l.locationCode}  ${l.locationName} (${l.locationType})`).join("\n") || "No locations matched." };
  },

  create_rank_tracker: async (ctx, a, env) => {
    const r = await createRankTracker(ctx, a.projectId, a as never);
    return { data: r, url: projectUrl(env, a.projectId, `/rank-tracking/${r.trackerId}`), text: `Created rank tracker ${r.trackerId} for ${r.config.domain}.` };
  },
  get_rank_tracker: (ctx, a, env) => {
    const r = getRankTracker(ctx, a.projectId, a.trackerId);
    return { data: r, url: projectUrl(env, a.projectId, a.trackerId ? `/rank-tracking/${a.trackerId}` : "/rank-tracking"), text: json(r) };
  },
  add_rank_tracking_keywords: (ctx, a) => {
    const r = addRankTrackingKeywords(ctx, a.projectId, a as never);
    return { data: r, text: `Added ${r.added} of ${r.requested} keyword(s).` };
  },
  remove_rank_tracking_keywords: (ctx, a) => {
    const r = removeRankTrackingKeywords(ctx, a.projectId, a as never);
    return { data: r, text: `Removed ${r.removed} of ${r.requested} keyword(s).` };
  },
  estimate_rank_tracker_cost: (ctx, a, env) => {
    const r = estimateRankTrackerCost(ctx, a.projectId, a as never);
    return { data: r, url: projectUrl(env, a.projectId, `/rank-tracking/${a.trackerId}`), text: `Estimated ${r.totalChecks} checks ≈ $${r.costUsd.toFixed(3)} (${r.costCredits} credits).` };
  },
  run_rank_tracker: (ctx, a) => {
    const r = runRankTracker(ctx, a.projectId, a as never);
    return { data: r, text: r.started ? `Started run ${r.runId}.` : `A run is already in progress (${r.blockingRunId}).` };
  },

  run_site_audit: (ctx, a, env) => {
    const r = startAudit(ctx, a.projectId, a as never);
    return { data: r, url: projectUrl(env, a.projectId, "/audit"), text: `Started site audit ${r.auditId}. Poll get_audit_status.` };
  },
  list_site_audits: (ctx, a, env) => {
    const r = listAudits(ctx, a.projectId);
    return { data: r, url: projectUrl(env, a.projectId, "/audit"), text: `${r.audits.length} audit(s).` };
  },
  delete_site_audit: (ctx, a) => {
    const r = deleteAudit(ctx, a.projectId, a.auditId);
    return { data: r, text: `Deleted audit ${r.auditId}.` };
  },
  get_audit_status: (ctx, a) => {
    const r = getAuditStatus(ctx, a.projectId, a.auditId);
    const s = r.status;
    return { data: r, text: `Audit ${s.id}: ${s.status}, ${s.pagesCrawled}/${s.maxPages} pages. Issues: ${s.issueCounts.critical} critical, ${s.issueCounts.warning} warnings, ${s.issueCounts.info} info.` };
  },
  get_audit_issues: (ctx, a) => {
    const r = getAuditIssues(ctx, a.projectId, a as never);
    return { data: r, text: r.summary.map((s) => `[${s.severity}] ${s.type} ×${s.count}`).join("\n") || "No issues." };
  },
  get_audit_pages: (ctx, a) => {
    const r = getAuditPages(ctx, a.projectId, a as never);
    return { data: r, text: `${r.total} page(s).\n${r.pages.slice(0, 50).map((p) => `${p.statusCode ?? "ERR"} ${p.url}`).join("\n")}` };
  },

  save_report: (ctx, a, env) => {
    const r = saveReport(ctx, a.projectId, env.baseUrl, a as never, env.clientLabel ?? "mcp");
    return { data: r, url: r.url, text: `${r.created ? "Created" : "Updated"} report ${r.reportId}: ${r.url}` };
  },
  list_reports: (ctx, a, env) => {
    const r = listReports(ctx, a.projectId, env.baseUrl, a);
    return { data: r, url: projectUrl(env, a.projectId, "/reports"), text: `${r.totalCount} report(s).\n${r.reports.map((x) => `- ${x.id}  ${x.title}`).join("\n")}` };
  },
  get_report: (ctx, a, env) => {
    const { report: { html, ...report } } = getReport(ctx, a.projectId, env.baseUrl, a as never) as { report: { html?: string } & Record<string, any> };
    // Structured output stays metadata-only; the document itself is delivered in the text block.
    return { data: { report }, url: report.url, text: html !== undefined ? html : `${report.title}\n${report.summary}` };
  },
  set_report_sharing: (ctx, a, env) => {
    const r = setReportSharing(ctx, a.projectId, env.baseUrl, a as never);
    return { data: r, url: r.url, text: r.public ? `Report is public: ${r.shareUrl}` : "Report is private." };
  },
  delete_report: (ctx, a, env) => {
    const r = deleteReport(ctx, a.projectId, a as never);
    return { data: r, url: projectUrl(env, a.projectId, "/reports"), text: `Deleted report ${r.reportId}.` };
  },
  list_report_templates: (ctx, a, env) => {
    const r = listReportTemplates(ctx, a.projectId);
    return { data: r, url: projectUrl(env, a.projectId, "/reports/templates"), text: `${r.templates.length} template(s).` };
  },
  save_report_template: (ctx, a, env) => {
    const r = saveReportTemplate(ctx, a.projectId, env.baseUrl, a as never);
    return { data: r, url: r.url, text: `${r.created ? "Created" : "Updated"} template ${r.templateId}.` };
  },
  delete_report_template: (ctx, a, env) => {
    const r = deleteReportTemplate(ctx, a.projectId, a as never);
    return { data: r, url: projectUrl(env, a.projectId, "/reports/templates"), text: `Deleted template ${r.templateId}.` };
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
