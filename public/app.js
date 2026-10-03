// CloseSEO web UI. No build step. All dynamic content is inserted via textContent / DOM nodes (never innerHTML).
const $app = document.getElementById("app");

// ---------- helpers ----------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 2500);
}
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `Request failed (${res.status})`);
  return json;
}
const tool = async (name, args) => (await api(`/api/tools/${name}`, { method: "POST", body: args })).data;
const fmt = (v) => (v == null ? "–" : typeof v === "number" ? v.toLocaleString() : String(v));
function table(cols, rows, empty = "No data.") {
  if (!rows.length) return h("div", { class: "empty" }, empty);
  return h("div", { class: "tbl" }, h("table", {},
    h("thead", {}, h("tr", {}, cols.map((c) => h("th", { class: c.num ? "num" : "" }, c.label)))),
    h("tbody", {}, rows.map((r) => h("tr", {}, cols.map((c) => h("td", { class: c.num ? "num" : "" }, c.render ? c.render(r) : fmt(r[c.key]))))))));
}
function form(fields, submitLabel, onSubmit) {
  const out = h("div", {});
  const f = h("form", { class: "row", onsubmit: async (e) => {
    e.preventDefault();
    const btn = f.querySelector("button[type=submit]");
    btn.disabled = true; out.replaceChildren();
    try { await onSubmit(Object.fromEntries(new FormData(f))); } catch (err) { out.replaceChildren(h("div", { class: "err" }, err.message)); } finally { btn.disabled = false; }
  } }, fields.map((x) => h("label", {}, x.label, x.type === "select"
    ? h("select", { name: x.name }, x.options.map((o) => h("option", { value: o }, o)))
    : x.type === "textarea" ? h("textarea", { name: x.name, placeholder: x.placeholder || "", value: x.value })
    : h("input", { name: x.name, type: x.type || "text", placeholder: x.placeholder || "", value: x.value, required: x.required, min: x.min, max: x.max, step: x.step, size: x.size }))),
    h("button", { type: "submit", class: "primary" }, submitLabel));
  return h("div", {}, f, out);
}
const lines = (s) => String(s || "").split(/\n+/).map((x) => x.trim()).filter(Boolean);
const num = (s) => (s === "" || s == null ? undefined : Number(s));
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ""));
function busy(node, promise) {
  node.replaceChildren(h("div", { class: "muted" }, "Loading…"));
  return promise.then((el) => node.replaceChildren(el), (e) => node.replaceChildren(h("div", { class: "err" }, e.message)));
}

// ---------- views ----------
async function projectsView() {
  const { projects } = await api("/api/projects");
  const list = h("div", {});
  const render = (ps) => list.replaceChildren(table(
    [{ label: "Project", render: (p) => h("a", { href: `#/p/${p.id}/dashboard` }, p.name) }, { label: "Domain", key: "domain" }, { label: "Market", render: (p) => `${p.locationCode}/${p.languageCode}` }], ps, "No projects yet. Create one below."));
  render(projects);
  return h("div", {}, h("h1", {}, "Projects"),
    h("div", { class: "card" }, list),
    h("div", { class: "card" }, h("h2", {}, "New project"), form([
      { name: "name", label: "Name", required: true }, { name: "domain", label: "Domain", placeholder: "example.com" },
      { name: "locationCode", label: "Location code", type: "number", value: "2840" }], "Create", async (v) => {
      const { project } = await api("/api/projects", { method: "POST", body: clean({ name: v.name, domain: v.domain, locationCode: num(v.locationCode) }) });
      location.hash = `#/p/${project.id}/dashboard`;
    })));
}

const TABS = [["dashboard", "Dashboard"], ["keywords", "Keywords"], ["saved", "Saved"], ["domain", "Domain"], ["backlinks", "Backlinks"], ["serp", "SERP"], ["rank", "Rank tracking"], ["ai", "AI visibility"], ["audit", "Site audit"], ["reports", "Reports"], ["assistant", "Assistant"], ["context", "Context"], ["usage", "Usage"], ["integrations", "Integrations"], ["settings", "Settings"]];

async function projectView(id, tab, sub) {
  const { project } = await api(`/api/projects/${id}`);
  const body = h("div", {});
  const views = { dashboard: dashboardTab, ai: aiTab, usage: usageTab, keywords: keywordsTab, saved: savedTab, domain: domainTab, backlinks: backlinksTab, serp: serpTab, rank: rankTab, audit: auditTab, reports: reportsTab, assistant: assistantTab, context: contextTab, integrations: integrationsTab, settings: settingsTab };
  const view = views[tab] || dashboardTab;
  busy(body, view(project, sub));
  return h("div", {}, h("h1", {}, project.name), h("div", { class: "muted" }, `${project.domain || "no domain"} · market ${project.locationCode}/${project.languageCode}`),
    h("nav", { class: "tabs" }, TABS.map(([k, l]) => h("a", { href: `#/p/${id}/${k}`, class: k === tab ? "on" : "" }, l))), body);
}

const kwCols = [{ label: "Keyword", key: "keyword" }, { label: "Volume", key: "searchVolume", num: 1 }, { label: "KD", key: "keywordDifficulty", num: 1 }, { label: "CPC", key: "cpc", num: 1 }, { label: "Intent", key: "intent" }];

async function keywordsTab(p) {
  const out = h("div", {});
  return h("div", {}, form([{ name: "seed", label: "Seed keyword", required: true }, { name: "limit", label: "Rows", type: "select", options: ["150", "300", "500"] }, { name: "group", label: "Group", type: "select", options: ["no", "yes"] }], "Research", async (v) => {
    out.replaceChildren(h("div", { class: "muted" }, "Researching…"));
    const d = await tool("research_keywords", { projectId: p.id, seeds: [{ seed: v.seed }], resultLimit: Number(v.limit), groupKeywords: v.group === "yes" });
    const r = d.results[0];
    if (!r.ok) throw new Error(r.error);
    const sel = new Set();
    const cols = [{ label: "", render: (row) => h("input", { type: "checkbox", onchange: (e) => (e.target.checked ? sel.add(row.keyword) : sel.delete(row.keyword)) }) }, ...(r.rows[0]?.group ? [{ label: "Group", key: "group" }] : []), ...kwCols];
    out.replaceChildren(h("p", { class: "muted" }, `${r.rowCount} keywords · source ${r.source}${r.usedFallback ? " (fallback)" : ""}`), table(cols, r.rows),
      h("button", { class: "primary", onclick: async () => {
        if (!sel.size) return toast("Select keywords first");
        const metrics = r.rows.filter((x) => sel.has(x.keyword)).map(({ keyword, searchVolume, cpc, competition, keywordDifficulty, intent }) => ({ keyword, searchVolume, cpc, competition, keywordDifficulty, intent }));
        await tool("save_keywords", { projectId: p.id, keywords: [...sel], metrics }); toast(`Saved ${sel.size} keywords`);
      } }, "Save selected"));
  }), out);
}

async function savedTab(p) {
  const filter = { search: "", tag: "", limit: 250 };
  const render = async () => {
    const d = await tool("list_saved_keywords", { projectId: p.id, limit: filter.limit, ...(filter.search ? { search: filter.search } : {}), ...(filter.tag ? { tags: [filter.tag] } : {}) });
    const box = h("div", {});
    const bar = h("div", { class: "row" },
      h("label", {}, "Search", h("input", { value: filter.search, placeholder: "keyword contains…", onchange: (e) => { filter.search = e.target.value.trim(); refresh(); } })),
      h("label", {}, "Tag", h("select", { onchange: (e) => { filter.tag = e.target.value; refresh(); } }, h("option", { value: "" }, "All tags"), d.tags.map((t) => h("option", { value: t.name, selected: t.name === filter.tag }, `${t.name} (${t.keywordCount})`)))),
      h("label", {}, "Rows", h("select", { onchange: (e) => { filter.limit = Number(e.target.value); refresh(); } }, [50, 100, 250].map((n) => h("option", { value: n, selected: n === filter.limit }, String(n))))));
    box.append(h("p", { class: "muted" }, `${d.totalCount} saved · tags: ${d.tags.map((t) => `${t.name} (${t.keywordCount})`).join(", ") || "none"}`), bar,
      table([...kwCols, { label: "Tags", render: (r) => r.tags.join(", ") }, { label: "", render: (r) => h("button", { class: "danger", onclick: async () => { await tool("remove_saved_keywords", { projectId: p.id, savedKeywordIds: [r.id] }); refresh(); } }, "Remove") }], d.rows, "Nothing saved yet."));
    return box;
  };
  const holder = h("div", {});
  const refresh = () => busy(holder, render());
  refresh();
  return h("div", {}, form([{ name: "kws", label: "Add keywords (one per line)", type: "textarea" }, { name: "tags", label: "Tags (comma separated)" }], "Add", async (v) => {
    const keywords = lines(v.kws); if (!keywords.length) throw new Error("Enter at least one keyword");
    await tool("save_keywords", { projectId: p.id, keywords, tags: v.tags.split(",").map((t) => t.trim()).filter(Boolean) }); toast("Saved"); refresh();
  }), holder);
}

async function domainTab(p) {
  const out = h("div", {});
  return h("div", {}, form([{ name: "domain", label: "Domain or URL", value: p.domain || "", required: true }], "Analyze", async (v) => {
    out.replaceChildren(h("div", { class: "muted" }, "Loading…"));
    const [o, k] = await Promise.all([tool("get_domain_overview", { projectId: p.id, domain: v.domain }), tool("get_ranked_keywords", { projectId: p.id, target: v.domain, limit: 50 })]);
    out.replaceChildren(h("div", { class: "grid card" }, [["Organic traffic", o.organicTraffic], ["Organic keywords", o.organicKeywords], ["Backlinks", o.backlinks], ["Referring domains", o.referringDomains]].map(([l, x]) => h("div", { class: "stat" }, h("b", {}, fmt(x)), h("span", { class: "muted" }, l)))),
      h("h2", {}, `Top ranked keywords${k.totalCount != null ? ` (${fmt(k.totalCount)} total)` : ""}`), table([
        { label: "Keyword", render: (r) => r.keyword_data?.keyword ?? "–" },
        { label: "Rank", num: 1, render: (r) => fmt(r.ranked_serp_element?.serp_item?.rank_absolute) },
        { label: "Volume", num: 1, render: (r) => fmt(r.keyword_data?.keyword_info?.search_volume) },
        { label: "Traffic", num: 1, render: (r) => fmt(r.ranked_serp_element?.serp_item?.etv != null ? Math.round(r.ranked_serp_element.serp_item.etv) : null) },
        { label: "URL", render: (r) => r.ranked_serp_element?.serp_item?.url ?? "–" }], k.keywords));
  }), out);
}

async function backlinksTab(p) {
  const out = h("div", {});
  return h("div", {}, form([{ name: "target", label: "Domain or URL", value: p.domain || "", required: true }], "Fetch", async (v) => {
    out.replaceChildren(h("div", { class: "muted" }, "Loading…"));
    const [o, b] = await Promise.all([tool("get_backlinks_overview", { projectId: p.id, target: v.target }), tool("get_backlinks_profile", { projectId: p.id, target: v.target })]);
    const sum = o.overview.overview.summary;
    out.replaceChildren(
      o.scopeNote ? h("p", { class: "muted" }, o.scopeNote) : null,
      h("div", { class: "grid card" }, [["Backlinks", sum.backlinks], ["Referring domains", sum.referringDomains], ["Rank", sum.rank], ["Spam score", sum.backlinksSpamScore], ["Broken backlinks", sum.brokenBacklinks]].map(([l, x]) => h("div", { class: "stat" }, h("b", {}, fmt(x)), h("span", { class: "muted" }, l)))),
      o.referringDomains ? h("div", {}, h("h2", {}, "Top referring domains"), table([{ label: "Domain", key: "domain" }, { label: "Backlinks", key: "backlinks", num: 1 }, { label: "Rank", key: "rank", num: 1 }, { label: "Spam", key: "spamScore", num: 1 }], o.referringDomains.rows.slice(0, 25))) : null,
      h("h2", {}, `Backlinks (${fmt(b.backlinks.totalCount)})`), table([{ label: "From", key: "urlFrom" }, { label: "Anchor", key: "anchor" }, { label: "Domain rank", key: "domainFromRank", num: 1 }, { label: "Follow", render: (r) => (r.isDofollow ? "dofollow" : "nofollow") }, { label: "First seen", key: "firstSeen" }], b.backlinks.rows));
  }), out);
}

async function serpTab(p) {
  const out = h("div", {});
  return h("div", {}, form([{ name: "kw", label: "Keywords (one per line)", type: "textarea" }, { name: "depth", label: "Depth", type: "select", options: ["10", "20", "50", "100"] }], "Fetch SERP", async (v) => {
    const queries = lines(v.kw).slice(0, 10).map((keyword) => ({ keyword })); if (!queries.length) throw new Error("Enter a keyword");
    out.replaceChildren(h("div", { class: "muted" }, "Loading…"));
    const d = await tool("get_serp_results", { projectId: p.id, queries, depth: Number(v.depth) });
    out.replaceChildren(...d.results.map((r) => h("div", { class: "card" }, h("h2", {}, r.keyword), r.ok ? table([{ label: "#", key: "rank", num: 1 }, { label: "Title", key: "title" }, { label: "URL", key: "url" }], r.items) : h("div", { class: "err" }, r.error))));
  }), out);
}

async function rankTab(p, trackerId) {
  if (trackerId) return rankDetail(p, trackerId);
  const d = await tool("get_rank_tracker", { projectId: p.id });
  return h("div", {}, table([{ label: "Domain", render: (c) => h("a", { href: `#/p/${p.id}/rank/${c.id}` }, c.domain) }, { label: "Devices", key: "devices" }, { label: "Depth", key: "serpDepth", num: 1 }, { label: "Schedule", key: "scheduleInterval" }, { label: "Next check", key: "nextCheckAt" }, { label: "Last checked", key: "lastCheckedAt" }], d.configs, "No rank trackers yet."),
    h("div", { class: "card" }, h("h2", {}, "New tracker"), form([{ name: "domain", label: "Domain", value: p.domain || "", required: true }, { name: "devices", label: "Devices", type: "select", options: ["mobile", "desktop", "both"] }, { name: "interval", label: "Schedule", type: "select", options: ["manual", "daily", "weekly", "monthly"] }], "Create", async (v) => {
      const r = await tool("create_rank_tracker", { projectId: p.id, domain: v.domain, devices: v.devices, scheduleInterval: v.interval }); location.hash = `#/p/${p.id}/rank/${r.trackerId}`;
    })));
}
async function rankDetail(p, trackerId) {
  const d = await tool("get_rank_tracker", { projectId: p.id, trackerId });
  const c = d.config, run = d.results.run;
  const devs = c.devices === "both" ? ["desktop", "mobile"] : [c.devices];
  const cell = (dev) => ({ label: dev, num: 1, render: (r) => {
    const x = r[dev]; if (!x || (x.position == null && x.previousPosition == null && !run)) return "–";
    const pos = x.position ?? `>${c.serpDepth}`; const change = x.position != null && x.previousPosition != null ? x.previousPosition - x.position : 0;
    return `${pos}${change ? ` (${change > 0 ? "▲" : "▼"}${Math.abs(change)})` : ""}`;
  } });
  const reload = () => { render(); };
  const histBox = h("div", {});
  const showHistory = (r) => busy(histBox, Promise.all(devs.map((dev) => api(`/api/projects/${p.id}/rank-trackers/${trackerId}/keywords/${r.trackingKeywordId}/history`).then((x) => x.history.filter((hh) => hh.device === dev))))
    .then((per) => h("div", { class: "card" }, h("h2", { style: "margin-top:0" }, `History: ${r.keyword}`), h("div", { class: "cols" }, devs.map((dev, i) => h("div", {}, h("h3", {}, dev), table([{ label: "Checked", render: (x) => x.checkedAt.slice(0, 16) }, { label: "Position", render: (x) => (x.position == null ? `>${c.serpDepth}` : x.position), num: 1 }], per[i], "No completed checks yet."))))),
    ));
  const trendBox = h("div", {});
  const trendDev = devs[0];
  busy(trendBox, Promise.all([api(`/api/projects/${p.id}/rank-trackers/${trackerId}/trend?device=${trendDev}`), api(`/api/projects/${p.id}/rank-trackers/${trackerId}/matrix?device=${trendDev}&runLimit=8`)]).then(([{ trend }, { matrix }]) => {
    if (!trend.length) return h("div", {});
    const kwName = new Map(d.results.rows.map((r) => [r.trackingKeywordId, r.keyword]));
    const runs = [...new Map(matrix.map((m) => [m.runId, m.checkedAt])).entries()];
    const byKw = new Map();
    for (const m of matrix) { const row = byKw.get(m.trackingKeywordId) || {}; row[m.runId] = m.position; byKw.set(m.trackingKeywordId, row); }
    return h("div", { class: "card" }, h("h2", { style: "margin-top:0" }, `Visibility over time (${trendDev})`),
      table([{ label: "Checked", render: (x) => x.checkedAt.slice(0, 16) }, { label: "Top 3", key: "top3", num: 1 }, { label: "4–10", key: "top4to10", num: 1 }, { label: "11–20", key: "top11to20", num: 1 }, { label: "Not ranking", key: "notRanking", num: 1 }], trend),
      h("h3", {}, "Positions by check"), table([{ label: "Keyword", render: (r) => r.keyword }, ...runs.map(([rid, at]) => ({ label: at.slice(5, 10), num: 1, render: (r) => { const v = (byKw.get(r.id) || {})[rid]; return v === undefined ? "–" : v == null ? ">" + c.serpDepth : v; } }))], [...kwName].map(([id, keyword]) => ({ id, keyword })), "No data."));
  }));
  const settings = h("div", { class: "card" }, h("h2", { style: "margin-top:0" }, "Settings"), form([
    { name: "devices", label: "Devices", type: "select", options: ["mobile", "desktop", "both"] }, { name: "serpDepth", label: "Depth", type: "select", options: ["10", "20", "30", "40", "50", "100"] },
    { name: "interval", label: "Schedule", type: "select", options: ["manual", "daily", "weekly", "monthly"] }], "Save settings", async (v) => {
    await api(`/api/projects/${p.id}/rank-trackers/${trackerId}`, { method: "PATCH", body: { devices: v.devices, serpDepth: Number(v.serpDepth), scheduleInterval: v.interval } }); toast("Saved"); reload();
  }), h("button", { class: "danger", onclick: async () => { if (!confirm("Archive this tracker? It disappears from the list; its history is kept.")) return; await api(`/api/projects/${p.id}/rank-trackers/${trackerId}`, { method: "PATCH", body: { isActive: false } }); location.hash = `#/p/${p.id}/rank`; } }, "Archive tracker"));
  const sel = (name, val) => { const el = settings.querySelector(`[name=${name}]`); if (el) el.value = val; };
  sel("devices", c.devices); sel("serpDepth", String(c.serpDepth)); sel("interval", c.scheduleInterval);
  return h("div", {}, h("h2", {}, `${c.domain} · ${c.devices} · top ${c.serpDepth} · ${c.scheduleInterval}`),
    h("p", { class: "muted" }, run ? `Last run ${run.status}${run.errorMessage ? ": " + run.errorMessage : ""}${run.completedAt ? " at " + run.completedAt : ""}` : "Never run"),
    table([{ label: "Keyword", render: (r) => h("a", { href: `#/p/${p.id}/rank/${trackerId}`, onclick: (e) => { e.preventDefault(); showHistory(r); } }, r.keyword) }, ...devs.map(cell), { label: "", render: (r) => h("button", { class: "danger", onclick: async () => { await tool("remove_rank_tracking_keywords", { projectId: p.id, trackerId, keywordIds: [r.trackingKeywordId] }); reload(); } }, "Remove") }], d.results.rows, "Add keywords, then run a check."),
    h("div", { class: "card" }, form([{ name: "kws", label: "Add keywords (one per line)", type: "textarea" }], "Add keywords", async (v) => {
      let ceiling;
      if (c.scheduleInterval !== "manual") {
        const est = await tool("estimate_rank_tracker_cost", { projectId: p.id, trackerId, additionalKeywords: lines(v.kws) });
        ceiling = est.scheduledEstimate?.costCredits;
        if (!confirm(`Each ${c.scheduleInterval} check will cost about ${ceiling} credits (~$${est.scheduledEstimate?.costUsd}). Add these keywords?`)) return;
      }
      await tool("add_rank_tracking_keywords", { projectId: p.id, trackerId, keywords: lines(v.kws), ...(ceiling != null ? { maxEstimatedScheduledCheckCredits: ceiling } : {}) }); reload();
    })),
    histBox, trendBox, settings,
    h("div", { class: "row" }, h("button", { class: "primary", onclick: async () => {
      const est = await tool("estimate_rank_tracker_cost", { projectId: p.id, trackerId });
      if (!confirm(`This check will cost about $${est.costUsd.toFixed(3)} of DataForSEO credit. Run it?`)) return;
      const r = await tool("run_rank_tracker", { projectId: p.id, trackerId, maxCostCredits: Math.max(est.costCredits, 1) }).catch((e) => (toast(e.message), null));
      if (r) { toast(r.started ? "Run started" : "A run is already in progress"); setTimeout(reload, 1500); }
    } }, "Run now"), h("button", { onclick: reload }, "Refresh")));
}

async function auditTab(p) {
  const holder = h("div", {});
  const list = async () => {
    const d = await tool("list_site_audits", { projectId: p.id });
    if (d.audits.some((a) => a.status === "running")) setTimeout(() => { if (holder.isConnected) busy(holder, list()); }, 2000);
    return table([{ label: "Started", key: "startedAt" }, { label: "URL", render: (a) => h("a", { href: `#/p/${p.id}/audit/${a.id}` }, a.startUrl) }, { label: "Status", key: "status" }, { label: "Pages", render: (a) => `${a.pagesCrawled}/${a.maxPages}` },
      { label: "Issues", render: (a) => `${a.issueCounts.critical} critical · ${a.issueCounts.warning} warn · ${a.issueCounts.info} info` },
      { label: "", render: (a) => h("button", { class: "danger", onclick: async () => { await tool("delete_site_audit", { projectId: p.id, auditId: a.id }); busy(holder, list()); } }, "Delete") }], d.audits, "No audits yet.");
  };
  busy(holder, list());
  return h("div", {}, form([{ name: "url", label: "Start URL", value: p.domain ? `https://${p.domain}` : "", required: true, size: 30 }, { name: "max", label: "Max pages", type: "number", value: "50", min: 1, max: 1000 }], "Run audit", async (v) => {
    await tool("run_site_audit", { projectId: p.id, url: v.url, maxPages: Number(v.max) }); toast("Audit started"); busy(holder, list());
  }), holder);
}
async function auditDetail(p, auditId) {
  const [st, iss, pg] = await Promise.all([tool("get_audit_status", { projectId: p.id, auditId }), tool("get_audit_issues", { projectId: p.id, auditId, limit: 200 }), tool("get_audit_pages", { projectId: p.id, auditId, limit: 200 })]);
  const s = st.status;
  return h("div", {}, h("p", {}, h("a", { href: `#/p/${p.id}/audit` }, "← All audits")), h("h2", {}, `${s.startUrl} — ${s.status}`), s.errorMessage && h("div", { class: "err" }, s.errorMessage),
    h("h2", {}, "Issues"), table([{ label: "Severity", render: (r) => h("span", { class: r.severity }, r.severity) }, { label: "Issue", key: "title" }, { label: "Pages", key: "count", num: 1 }], iss.summary, "No issues found."),
    h("h2", {}, "Issue details"), table([{ label: "Severity", render: (r) => h("span", { class: r.severity }, r.severity) }, { label: "Type", key: "type" }, { label: "URL", key: "url" }, { label: "Detail", key: "detail" }], iss.issues),
    h("h2", {}, `Pages (${pg.total})`), table([{ label: "Status", key: "statusCode" }, { label: "URL", key: "url" }, { label: "Title", key: "title" }, { label: "Words", key: "wordCount", num: 1 }, { label: "ms", key: "responseMs", num: 1 }], pg.pages));
}

async function reportsTab(p, rid) {
  if (rid) {
    const { report } = await tool("get_report", { projectId: p.id, reportId: rid });
    const frame = h("iframe", { sandbox: "", style: "width:100%;height:70vh;border:1px solid var(--line);border-radius:8px;background:#fff" });
    const res = await fetch(`/api/projects/${p.id}/reports/${rid}/html`); frame.srcdoc = res.ok ? await res.text() : "";
    return h("div", {}, h("p", {}, h("a", { href: `#/p/${p.id}/reports` }, "← Reports")), h("h2", {}, report.title), h("p", { class: "muted" }, report.summary),
      h("div", { class: "row" }, h("button", { onclick: async () => {
          try { const r = await tool("set_report_sharing", { projectId: p.id, reportId: rid, public: !report.shareUrl }); toast(r.public ? r.shareUrl : "Sharing disabled"); render(); } catch (e) { toast(e.message); }
        } }, report.shareUrl ? "Stop sharing" : "Share publicly"),
        report.shareUrl && h("a", { href: report.shareUrl, target: "_blank", rel: "noopener" }, report.shareUrl),
        h("button", { class: "danger", onclick: async () => { if (confirm("Delete this report?")) { await tool("delete_report", { projectId: p.id, reportId: rid }); location.hash = `#/p/${p.id}/reports`; } } }, "Delete")), frame);
  }
  const d = await tool("list_reports", { projectId: p.id, limit: 50 });
  return h("div", {}, table([{ label: "Title", render: (r) => h("a", { href: `#/p/${p.id}/reports/${r.id}` }, r.title) }, { label: "Written by", key: "createdBy" }, { label: "Updated", key: "updatedAt" }, { label: "Size", render: (r) => `${Math.ceil(r.sizeBytes / 1000)} KB` }], d.reports, "No reports yet. Agents create reports through the MCP save_report tool."));
}

async function contextTab(p) {
  const c = await tool("get_project_context", { projectId: p.id });
  const std = ["business_overview", "current_goal", "positioning", "writing_preferences"];
  return h("div", {}, h("p", { class: "muted" }, "Shared memory that agents read before doing work."),
    ...std.map((s) => { const cur = c.sections.find((x) => x.key === s); return h("div", { class: "card" }, h("h2", {}, s.replace(/_/g, " ")), form([{ name: "content", label: "Content", type: "textarea", value: cur?.content }], "Save", async (v) => { await tool("update_project_context", { projectId: p.id, updates: [{ section: s, content: v.content }] }); toast("Saved"); }));
    }),
    h("h2", {}, "Competitors"), table([{ label: "Domain", key: "domain" }, { label: "Name", key: "name" }], c.competitors, "None"),
    h("h2", {}, "Key pages"), table([{ label: "URL", key: "url" }, { label: "Role", key: "role" }], c.keyPages, "None"));
}

// ---- minimal, safe Markdown: everything is built with DOM nodes, so model output can never inject HTML.
function inlineMd(text) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(h("strong", {}, t.slice(2, -2)));
    else if (t.startsWith("`")) out.push(h("code", {}, t.slice(1, -1)));
    else { const [, label, url] = /^\[([^\]]+)\]\((.+)\)$/.exec(t); out.push(h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, label)); }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function markdown(src) {
  const root = h("div", { class: "md" });
  const lines = String(src).replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; ) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(l); i += 2; const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      root.append(h("div", { class: "tbl" }, h("table", {}, h("thead", {}, h("tr", {}, head.map((c) => h("th", {}, inlineMd(c))))), h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c) => h("td", {}, inlineMd(c)))))))));
      continue;
    }
    const hd = /^(#{1,4})\s+(.*)$/.exec(l);
    if (hd) { root.append(h("h3", {}, inlineMd(hd[2]))); i++; continue; }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l); const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(h("li", {}, inlineMd(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""))));
      root.append(h(ordered ? "ol" : "ul", {}, items)); continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*\|/.test(lines[i]) && !/^(#{1,4})\s/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) para.push(lines[i++]);
    root.append(h("p", {}, inlineMd(para.join(" "))));
  }
  return root;
}

async function assistantTab(p) {
  const base = `/api/projects/${encodeURIComponent(p.id)}/agent`;
  const info = await api(`${base}/sessions`);
  if (!info.enabled) return h("div", { class: "card" }, h("h2", {}, "The assistant is off"), h("p", {}, "Set OPENROUTER_API_KEY and restart CloseSEO to chat with an SEO assistant that uses this project's data and memory."), h("p", { class: "muted" }, "It spends your OpenRouter credit, plus DataForSEO balance for paid lookups. Each message has a hard spending cap."));
  let sessionId = sessionStorageGet(p.id) && info.sessions.some((x) => x.id === sessionStorageGet(p.id)) ? sessionStorageGet(p.id) : info.sessions[0]?.id ?? null;
  const log = h("div", { class: "chat" }), meta = h("div", { class: "muted" }), box = h("div", {});
  const input = h("textarea", { id: "chat-input", placeholder: "Ask about keywords, competitors, rankings, your site…", rows: "3" });
  const send = h("button", { class: "primary", id: "chat-send" }, "Send");
  const picker = h("select", { id: "chat-session" });
  const bubble = (m) => h("div", { class: `bubble ${m.role}` }, m.role === "user" ? h("div", {}, m.text) : markdown(m.text || ""), m.tools?.length ? h("div", { class: "chips" }, m.tools.map((t) => h("span", { class: "pill" }, t))) : null);
  async function loadSessions() {
    const list = (await api(`${base}/sessions`)).sessions;
    picker.replaceChildren(h("option", { value: "" }, list.length ? "Select a chat" : "No chats yet"), ...list.map((x) => h("option", { value: x.id, selected: x.id === sessionId }, `${x.title} · $${x.totalCostUsd.toFixed(4)}`)));
  }
  async function show() {
    log.replaceChildren();
    if (!sessionId) { log.append(h("div", { class: "empty" }, "Start a chat. Try: “What do you know about this project?”")); meta.textContent = `Model: ${info.model}`; return; }
    const t = await api(`${base}/sessions/${sessionId}`);
    t.messages.forEach((m) => log.append(bubble(m)));
    meta.textContent = `Model: ${info.model} · this chat has cost $${t.totalCostUsd.toFixed(4)}`;
    log.scrollTop = log.scrollHeight;
  }
  picker.addEventListener("change", async () => { sessionId = picker.value || null; sessionStoragePut(p.id, sessionId); await show(); });
  async function submit() {
    const text = input.value.trim(); if (!text) return;
    send.disabled = true; input.disabled = true;
    try {
      if (!sessionId) { sessionId = (await api(`${base}/sessions`, { method: "POST", body: {} })).session.id; sessionStoragePut(p.id, sessionId); }
      log.querySelector(".empty")?.remove();
      log.append(bubble({ role: "user", text })); const wait = h("div", { class: "bubble assistant muted" }, "Thinking…"); log.append(wait); log.scrollTop = log.scrollHeight;
      input.value = "";
      try { await api(`${base}/sessions/${sessionId}/messages`, { method: "POST", body: { text } }); } catch (e) { wait.replaceWith(h("div", { class: "bubble assistant err" }, e.message)); await loadSessions(); return; }
      await loadSessions(); await show();
    } finally { send.disabled = false; input.disabled = false; input.focus(); }
  }
  send.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); });
  await loadSessions(); await show();
  return h("div", {}, h("div", { class: "row" }, picker, h("button", { onclick: async () => { sessionId = null; sessionStoragePut(p.id, null); picker.value = ""; await show(); input.focus(); } }, "New chat"),
    h("button", { class: "danger", onclick: async () => { if (!sessionId || !confirm("Delete this chat?")) return; await api(`${base}/sessions/${sessionId}`, { method: "DELETE" }); sessionId = null; sessionStoragePut(p.id, null); await loadSessions(); await show(); } }, "Delete chat")),
    log, meta, h("div", { class: "row" }, input, send), h("p", { class: "muted" }, "Ctrl/⌘+Enter sends. Paid data lookups spend your DataForSEO balance; the assistant asks before big batches."), box);
}
function sessionStorageGet(k) { try { return localStorage.getItem(`cs-chat-${k}`); } catch { return null; } }
function sessionStoragePut(k, v) { try { v ? localStorage.setItem(`cs-chat-${k}`, v) : localStorage.removeItem(`cs-chat-${k}`); } catch { /* storage unavailable */ } }

async function integrationsTab(p) {
  const params = new URLSearchParams(location.search);
  const st = await api(`/api/google/status?projectId=${encodeURIComponent(p.id)}`);
  const flash = params.get("google_error") ? h("div", { class: "err" }, `Google sign-in did not finish: ${params.get("google_error")}`) : params.get("google") ? h("div", { class: "ok" }, "Google account connected. Choose what to use below.") : null;
  if (params.has("google") || params.has("google_error")) history.replaceState(null, "", location.pathname + location.hash);
  if (!st.configured) {
    return h("div", {}, h("div", { class: "card" }, h("h2", {}, "Google is not set up on this server"),
      h("p", {}, "Search Console and Analytics need a Google OAuth client. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and CLOSESEO_SECRET (32+ characters), then restart."),
      h("p", { class: "muted" }, "Authorized redirect URIs to register in Google Cloud:"), h("pre", {}, Object.values(st.redirectUris).join("\n")), h("p", { class: "muted" }, "See docs/GOOGLE.md.")));
  }
  const connect = (provider) => h("button", { class: "primary", onclick: async () => { try { const { url } = await api(`/api/google/${provider}/start`, { method: "POST", body: { projectId: p.id } }); location.href = url; } catch (e) { toast(e.message); } } }, "Connect a Google account");
  const section = (provider, title, current, accounts, items, label, pick) => h("div", { class: "card" }, h("h2", {}, title),
    current ? h("p", {}, `Using ${label(current)}${current.email ? ` (connected by ${current.email})` : ""}.`) : h("p", { class: "muted" }, "Not connected to this project."),
    ...accounts.map((a) => h("div", {}, h("p", { class: "muted" }, a.email ?? "Google account", a.requiresReconnect ? " — needs reconnecting" : a.propertiesUnavailable ? " — could not list properties" : ""),
      items(a).length ? table([{ label: "Choose", render: (it) => h("button", { onclick: async () => { try { await api(`/api/google/${provider}/select`, { method: "POST", body: { projectId: p.id, grantId: a.grantId, ...pick(it) } }); toast("Saved"); render(); } catch (e) { toast(e.message); } } }, "Use this"), }, { label: "Name", render: (it) => it.name }], items(a)) : null)),
    h("div", { class: "row" }, connect(provider), current ? h("button", { class: "danger", onclick: async () => { await api(`/api/google/${provider}/${p.id}`, { method: "DELETE" }); render(); } }, "Disconnect") : null));
  const perf = h("div", {});
  if (st.gsc.connection) busy(perf, tool("get_search_console_performance", { projectId: p.id, dimensions: ["query"], rowLimit: 25 }).then((d) => d.ok ? h("div", {}, h("h2", {}, "Top queries, last 28 days"), table([{ label: "Query", render: (r) => r.keys?.[0] }, { label: "Clicks", key: "clicks", num: 1 }, { label: "Impressions", key: "impressions", num: 1 }, { label: "CTR", num: 1, render: (r) => `${(r.ctr * 100).toFixed(1)}%` }, { label: "Position", num: 1, render: (r) => r.position?.toFixed(1) }], d.rows)) : h("div", { class: "err" }, "Could not read Search Console.")).catch((e) => h("div", { class: "err" }, e.message)));
  return h("div", {}, flash,
    section("gsc", "Google Search Console", st.gsc.connection && { ...st.gsc.connection, name: st.gsc.connection.siteUrl }, st.gsc.accounts, (a) => a.sites.map((s) => ({ name: `${s.siteUrl} (${s.permissionLevel})`, siteUrl: s.siteUrl })), (c) => c.siteUrl, (it) => ({ siteUrl: it.siteUrl })),
    perf,
    section("ga4", "Google Analytics 4", st.ga4.connection, st.ga4.accounts, (a) => a.properties.map((x) => ({ name: `${x.displayName} · ${x.accountDisplayName} · ${x.propertyId}`, propertyId: x.propertyId })), (c) => `${c.displayName} (${c.propertyId})`, (it) => ({ propertyId: it.propertyId })));
}

async function settingsTab(p) {
  return h("div", {}, h("div", { class: "card" }, h("h2", {}, "Project settings"), form([{ name: "name", label: "Name", value: p.name }, { name: "domain", label: "Domain", value: p.domain || "" }, { name: "locationCode", label: "Location code", type: "number", value: String(p.locationCode) }], "Save", async (v) => {
    await api(`/api/projects/${p.id}`, { method: "PATCH", body: { name: v.name, domain: v.domain || null, locationCode: Number(v.locationCode) } }); toast("Saved"); render();
  })), h("div", { class: "card" }, h("h2", {}, "Danger zone"), h("button", { class: "danger", onclick: async () => { if (confirm(`Delete "${p.name}" and all its data?`)) { await api(`/api/projects/${p.id}`, { method: "DELETE" }); location.hash = "#/"; } } }, "Delete project")));
}

// ---------- dashboard ----------
const usd = (n) => (n == null ? "–" : `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`);
const pct = (n) => (n == null ? "–" : `${Math.round(n)}%`);
const bar = (value, max, cls = "") => h("div", { class: `bar ${cls}` }, h("i", { style: `width:${max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0}%` }));
const stat = (label, value, note) => h("div", { class: "card stat" }, h("span", { class: "muted" }, label), h("b", {}, value), note ? h("span", { class: "muted" }, note) : null);

async function dashboardTab(p) {
  const d = await api(`/api/projects/${p.id}/dashboard`);
  const holder = h("div", {});
  const reload = () => busy(holder, dashboardTab(p).then((el) => el.firstChild));
  const toggle = async (key, hide) => { await api(`/api/projects/${p.id}/dashboard/steps/${key}/dismiss`, { method: hide ? "POST" : "DELETE" }); reload(); };
  const done = d.steps.filter((s) => s.done).length;
  const open = d.steps.filter((s) => !s.done && !s.dismissed);
  const hidden = d.steps.filter((s) => s.dismissed);
  const setup = open.length || hidden.length ? h("div", { class: "card" }, h("h2", { style: "margin-top:0" }, `Get set up · ${done} of ${d.steps.length} done`), bar(done, d.steps.length),
    ...open.map((s) => h("div", { class: "step" }, h("div", {}, h("b", {}, s.title), h("div", { class: "muted" }, s.description)),
      h("div", { class: "row" }, h("a", { class: "btn", href: `#/p/${p.id}/${s.tab}` }, "Open"), h("button", { onclick: () => toggle(s.key, true) }, "Hide")))),
    hidden.length ? h("p", { class: "muted" }, `Hidden: ${hidden.map((s) => s.title).join(", ")} `, h("button", { onclick: async () => { for (const s of hidden) await api(`/api/projects/${p.id}/dashboard/steps/${s.key}/dismiss`, { method: "DELETE" }); reload(); } }, "Show again")) : null) : h("div", { class: "card ok" }, `All ${d.steps.length} setup steps are done.`);
  const r = d.rankings;
  const spendNote = d.spend.budget ? `of ${usd(d.spend.budget.monthlyLimitUsd)} budget` : d.spend.globalBudget ? `of ${usd(d.spend.globalBudget.monthlyLimitUsd)} overall budget` : "no limit set";
  const stats = h("div", { class: "grid" },
    stat("Saved keywords", fmt(d.counts.savedKeywords)), stat("Tracked keywords", fmt(r.trackedKeywords), r.trackedKeywords ? `${r.ranking} ranking` : "none yet"),
    stat("Average position", r.averagePosition == null ? "–" : String(r.averagePosition), r.lastCheckedAt ? `checked ${r.lastCheckedAt.slice(0, 10)}` : null), stat("In top 10", fmt(r.top10), r.top3 ? `${r.top3} in top 3` : null),
    stat("AI mentions", d.ai.lastBrand ? fmt(d.ai.lastBrand.totalMentions) : "–", d.ai.lastBrand ? d.ai.lastBrand.query : "no lookup yet"), stat("Spent this month", usd(d.spend.monthUsd), spendNote));
  const cards = h("div", { class: "cols" },
    h("div", { class: "card" }, h("h2", { style: "margin-top:0" }, "Rankings"),
      r.trackedKeywords ? h("div", {}, h("p", {}, `${r.ranking} of ${r.trackedKeywords} keywords rank in the results checked.`), h("p", {}, h("span", { class: "ok" }, `▲ ${r.improved} up`), "  ", h("span", { class: "critical" }, `▼ ${r.declined} down`)), h("a", { href: `#/p/${p.id}/rank` }, "Open rank tracking"))
        : h("div", { class: "muted" }, "No keywords tracked yet. ", h("a", { href: `#/p/${p.id}/rank` }, "Start tracking"))),
    h("div", { class: "card" }, h("h2", { style: "margin-top:0" }, "Site audit"),
      d.audit ? h("div", {}, h("p", { class: "muted" }, `${d.audit.startUrl} · ${d.audit.status} · ${d.audit.pagesCrawled} pages`),
        d.audit.topIssues.length ? table([{ label: "Issue", render: (i) => h("span", { class: i.severity }, i.type.replaceAll("_", " ")) }, { label: "Pages", key: "pages", num: 1 }], d.audit.topIssues) : h("div", { class: "muted" }, "No issues recorded."),
        h("a", { href: `#/p/${p.id}/audit/${d.audit.id}` }, "Open audit")) : h("div", { class: "muted" }, "No audit yet. ", h("a", { href: `#/p/${p.id}/audit` }, "Crawl your site"))),
    h("div", { class: "card" }, h("h2", { style: "margin-top:0" }, "AI visibility"),
      d.ai.lastBrand ? h("div", {}, h("p", {}, `${d.ai.lastBrand.query}: ${fmt(d.ai.lastBrand.totalMentions)} mentions, AI search volume ${fmt(d.ai.lastBrand.totalAiSearchVolume)}.`),
        d.ai.lastBrand.sharePct != null ? h("p", {}, `Share of voice ${pct(d.ai.lastBrand.sharePct)} among the brands you compared.`) : null, h("a", { href: `#/p/${p.id}/ai` }, "Open AI visibility"))
        : h("div", { class: "muted" }, "See whether AI assistants mention you. ", h("a", { href: `#/p/${p.id}/ai` }, "Check now"))),
    h("div", { class: "card" }, h("h2", { style: "margin-top:0" }, "Connections"),
      h("p", {}, d.gsc ? `Search Console: ${d.gsc.siteUrl}` : "Search Console: not connected"), h("p", {}, d.ga4 ? `Analytics: ${d.ga4.property}` : "Analytics: not connected"), h("a", { href: `#/p/${p.id}/integrations` }, "Manage")));
  holder.append(setup, stats, cards);
  return h("div", {}, holder);
}

// ---------- AI visibility ----------
const MODEL_LABEL = { chat_gpt: "ChatGPT", claude: "Claude", gemini: "Gemini", perplexity: "Perplexity" };
let aiMode = "prompt";

async function aiTab(p) {
  const info = await api("/api/ai/models");
  const panel = h("div", {});
  const history = h("div", {});
  const showRun = async (id) => {
    const { kind, result } = await api(`/api/projects/${p.id}/ai/runs/${id}`);
    aiMode = kind; draw(); panel.querySelector(".result").replaceChildren(kind === "prompt" ? promptResult(result) : brandResult(result));
  };
  const loadHistory = () => busy(history, api(`/api/projects/${p.id}/ai/runs`).then(({ runs }) => runs.length ? h("div", { class: "card" }, h("h2", { style: "margin-top:0" }, "Recent lookups"),
    table([{ label: "When", render: (r) => r.createdAt.slice(0, 16).replace("T", " ") }, { label: "Type", render: (r) => (r.kind === "prompt" ? "Prompt" : "Brand") }, { label: "Query", key: "query" },
      { label: "", render: (r) => h("span", { class: "row" }, h("button", { onclick: () => showRun(r.id).catch((e) => toast(e.message)) }, "Open"), h("button", { class: "danger", onclick: async () => { await api(`/api/projects/${p.id}/ai/runs/${r.id}`, { method: "DELETE" }); loadHistory(); } }, "Delete")) }], runs)) : h("div", {})));
  const draw = () => {
    const out = h("div", { class: "result" });
    panel.replaceChildren(h("div", { class: "seg" }, ["prompt", "brand"].map((m) => h("button", { class: m === aiMode ? "on" : "", onclick: () => { aiMode = m; draw(); } }, m === "prompt" ? "Prompt explorer" : "Brand lookup"))),
      aiMode === "prompt" ? promptForm(out) : brandForm(out), out);
  };
  const promptForm = (out) => {
    const models = h("div", { class: "row checks" }, Object.keys(MODEL_LABEL).map((m) => h("label", { class: "inline" }, h("input", { type: "checkbox", name: "m", value: m, checked: true }), MODEL_LABEL[m])));
    const country = h("select", { name: "country" }, h("option", { value: "default" }, "Any country"), info.webSearchCountries.all.map((c) => h("option", { value: c }, c)));
    const f = h("form", { class: "card", onsubmit: async (e) => {
      e.preventDefault();
      const btn = f.querySelector("button[type=submit]"); btn.disabled = true;
      out.replaceChildren(h("div", { class: "muted" }, "Asking the models… this can take up to a minute."));
      try {
        const fd = new FormData(f);
        const res = await api(`/api/projects/${p.id}/ai/prompt`, { method: "POST", body: clean({ prompt: fd.get("prompt"), models: fd.getAll("m"), highlightBrand: fd.get("brand") || undefined, webSearch: fd.get("web") === "on", webSearchCountryCode: fd.get("country") === "default" ? undefined : fd.get("country") }) });
        out.replaceChildren(promptResult(res)); loadHistory();
      } catch (err) { out.replaceChildren(h("div", { class: "err" }, err.message)); } finally { btn.disabled = false; }
    } },
      h("label", {}, "Prompt (what a customer might ask an AI)", h("textarea", { name: "prompt", maxlength: "500", required: true, placeholder: "What is the best project management tool for small teams?" })),
      h("div", { class: "row" }, h("label", {}, "Highlight brand", h("input", { name: "brand", placeholder: "Your brand or domain" })), h("label", {}, "Search country", country), h("label", { class: "inline" }, h("input", { type: "checkbox", name: "web", checked: true }), "Use web search")),
      models, h("p", { class: "muted" }, "Each model is one paid call (about 1–2 cents). Answers are kept for 7 days, so asking again is free."), h("button", { type: "submit", class: "primary" }, "Ask"));
    return f;
  };
  const brandForm = (out) => {
    const f = h("form", { class: "card", onsubmit: async (e) => {
      e.preventDefault();
      const btn = f.querySelector("button[type=submit]"); btn.disabled = true;
      out.replaceChildren(h("div", { class: "muted" }, "Looking up mentions…"));
      try {
        const fd = new FormData(f);
        const res = await api(`/api/projects/${p.id}/ai/brand`, { method: "POST", body: clean({ query: fd.get("query"), competitors: String(fd.get("competitors") || "").split(",").map((x) => x.trim()).filter(Boolean), scope: fd.get("scope") || undefined }) });
        out.replaceChildren(brandResult(res)); loadHistory();
      } catch (err) { out.replaceChildren(h("div", { class: "err" }, err.message)); } finally { btn.disabled = false; }
    } },
      h("div", { class: "row" }, h("label", {}, "Brand, domain or keyword", h("input", { name: "query", required: true, value: p.domain || "", placeholder: "example.com", maxlength: "250" })),
        h("label", {}, "Compare with (up to 5, comma separated)", h("input", { name: "competitors", size: 36, placeholder: "rival.com, other.com" })),
        h("label", {}, "Scope", h("select", { name: "scope" }, h("option", { value: "" }, "Automatic"), ["subdomains", "domain", "subfolder", "exact_url"].map((s) => h("option", { value: s }, s))))),
      h("p", { class: "muted" }, "About 6–8 paid lookups. DataForSEO charges about $0.10 per summary call and more for lists, so a full lookup can cost $1–$2. Results are kept for 24 hours; set a budget on the Usage page if unsure."), h("button", { type: "submit", class: "primary" }, "Look up"));
    return f;
  };
  draw(); loadHistory();
  return h("div", {}, panel, history);
}

function citationList(cites) {
  if (!cites.length) return h("div", { class: "muted" }, "No sources cited.");
  return h("ol", { class: "cites" }, cites.map((c) => h("li", { class: c.matchedBrand ? "hit" : "" }, h("a", { href: c.url, target: "_blank", rel: "noopener noreferrer nofollow" }, c.title || c.domain || c.url), " ", h("span", { class: "muted" }, c.domain || ""), c.matchedBrand ? h("span", { class: "pill ok" }, "brand") : null)));
}
function promptResult(res) {
  const mentioned = res.results.filter((r) => r.status === "success" && r.brandMentioned === true).length;
  const asked = res.results.filter((r) => r.status === "success").length;
  return h("div", {}, h("p", { class: "muted" }, `${res.prompt.length > 90 ? res.prompt.slice(0, 90) + "…" : res.prompt} · cost ${usd(res.costUsd)}`),
    res.highlightBrand ? h("p", {}, h("b", {}, res.highlightBrand), ` was mentioned by ${mentioned} of ${asked} answers.`) : null,
    h("div", { class: "cols" }, res.results.map((r) => r.status === "error"
      ? h("div", { class: "card" }, h("h2", { style: "margin-top:0" }, MODEL_LABEL[r.model]), h("div", { class: "err" }, r.message))
      : h("div", { class: "card" }, h("h2", { style: "margin-top:0" }, MODEL_LABEL[r.model], " ", h("span", { class: "muted" }, r.modelName || "")),
        h("div", { class: "chips" }, r.brandMentioned === true ? h("span", { class: "pill ok" }, "brand mentioned") : r.brandMentioned === false ? h("span", { class: "pill critical" }, "brand not mentioned") : null,
          h("span", { class: "pill" }, r.webSearch ? "web search used" : "no web search"), r.cached ? h("span", { class: "pill" }, "cached") : null, r.webSearchCountryCode ? h("span", { class: "pill" }, r.webSearchCountryCode) : null),
        r.text ? markdown(r.text) : h("div", { class: "muted" }, "The model returned no visible text."),
        h("h3", {}, `Sources (${r.citations.length})`), citationList(r.citations),
        r.fanOutQueries.length ? h("div", {}, h("h3", {}, "Searches it ran"), h("div", { class: "chips" }, r.fanOutQueries.map((q) => h("span", { class: "pill" }, q)))) : null))));
}
function brandResult(r) {
  const sov = r.shareOfVoice;
  const maxVol = Math.max(0, ...r.monthlyVolume.map((m) => m.volume));
  if (!r.hasData) return h("div", { class: "card" }, h("p", {}, `No AI mentions found for ${r.resolvedTarget}.`), h("p", { class: "muted" }, "That usually means AI assistants rarely cite it yet, or the name is too new. Cost: " + usd(r.costUsd)));
  return h("div", {}, h("p", { class: "muted" }, `${r.resolvedTarget} · ${r.cached ? "from cache (free)" : `cost ${usd(r.costUsd)}`}${r.aggregatesAreDomainLevel ? " · totals are for the whole domain; pages and questions are filtered to your path" : ""}`),
    h("div", { class: "grid" }, stat("Mentions", fmt(r.totalMentions)), stat("AI search volume", fmt(r.totalAiSearchVolume)),
      ...r.perPlatform.map((x) => stat(x.platform === "chat_gpt" ? "ChatGPT" : "Google AI", x.status === "error" ? "unavailable" : fmt(x.mentions), x.status === "success" ? `volume ${fmt(x.aiSearchVolume)}` : null))),
    sov ? h("div", { class: "card" }, h("h2", { style: "margin-top:0" }, "Share of voice"), ...sov.entries.map((e) => h("div", { class: "sov" }, h("span", { class: e.isTarget ? "me" : "" }, e.label), bar(e.sharePct ?? 0, 100, e.isTarget ? "me" : ""), h("span", { class: "num" }, e.sharePct == null ? "no data" : `${pct(e.sharePct)} · ${fmt(e.mentions)}`)))) : null,
    r.monthlyVolume.length ? h("div", { class: "card" }, h("h2", { style: "margin-top:0" }, "AI search volume by month"), h("div", { class: "spark" }, r.monthlyVolume.map((m) => h("div", { class: "col", title: `${m.year}-${String(m.month).padStart(2, "0")}: ${fmt(m.volume)}` }, h("i", { style: `height:${maxVol ? Math.max(3, (m.volume / maxVol) * 100) : 3}%` }), h("span", {}, `${m.month}`))))) : null,
    h("h2", {}, "Most cited pages"), table([{ label: "Page", render: (x) => h("a", { href: x.url, target: "_blank", rel: "noopener noreferrer nofollow" }, x.url) }, { label: "Source", render: (x) => (x.platform === "chat_gpt" ? "ChatGPT" : "Google AI") }, { label: "Mentions", key: "mentions", num: 1 }, { label: "Volume", key: "capturedVolume", num: 1 }, { label: "Questions", render: (x) => x.keywords.slice(0, 3).map((k) => k.question).join(" · ") }], r.topPages, "No cited pages."),
    h("h2", {}, "Questions that mention it"), table([{ label: "Question", key: "question" }, { label: "Source", render: (x) => (x.platform === "chat_gpt" ? "ChatGPT" : "Google AI") }, { label: "Volume", key: "aiSearchVolume", num: 1 }, { label: "Brands named", render: (x) => x.brandsMentioned.join(", ") }], r.topQueries, "No questions."));
}

// ---------- usage & budgets ----------
async function usageTab(p) {
  const q = p ? `?projectId=${encodeURIComponent(p.id)}` : "";
  const u = await api(`/api/usage${q}`);
  const holder = h("div", {});
  const reload = () => busy(holder, usageTab(p).then((el) => el.firstChild));
  const own = u.budgets.find((b) => (p ? b.projectId === p.id : b.projectId === null));
  const setLimit = async (v) => { await api("/api/budgets", { method: "PUT", body: { projectId: p ? p.id : null, monthlyLimitUsd: v } }); reload(); };
  const budgetCard = h("div", { class: "card" }, h("h2", { style: "margin-top:0" }, p ? "Project budget" : "Monthly budget (all projects)"),
    own ? h("div", {}, h("p", { class: own.status === "exceeded" ? "critical" : own.status === "warning" ? "warning" : "" }, `${usd(own.spentUsd)} of ${usd(own.monthlyLimitUsd)} used (${pct(own.percent)})${own.status === "exceeded" ? " — new paid calls are blocked until you raise the limit" : own.status === "warning" ? " — close to the limit" : ""}`), bar(own.spentUsd, own.monthlyLimitUsd, own.status))
      : h("p", { class: "muted" }, "No limit set. Paid calls are never blocked."),
    p && u.budgets.find((b) => b.projectId === null) ? h("p", { class: "muted" }, `The overall budget (${usd(u.budgets.find((b) => b.projectId === null).monthlyLimitUsd)}) also applies.`) : null,
    form([{ name: "limit", label: "Limit per month (USD)", type: "number", min: "0.01", step: "any", value: own ? String(own.monthlyLimitUsd) : "", required: true }], own ? "Update limit" : "Set limit", async (v) => { await setLimit(Number(v.limit)); }),
    own ? h("button", { class: "danger", onclick: () => setLimit(null) }, "Remove limit") : null,
    h("p", { class: "muted" }, "Limits stop new paid calls (DataForSEO and OpenRouter) once the month's spend reaches them. A request already running is not interrupted. The month resets on the 1st (UTC)."));
  const maxDay = Math.max(0, ...u.daily.map((d) => d.usd));
  const maxF = Math.max(0, ...u.byFeature.map((f) => f.usd));
  holder.append(h("div", { class: "grid" }, stat(`Spent in ${u.month}`, usd(u.totalUsd)), ...u.byProvider.map((x) => stat(x.provider === "dataforseo" ? "DataForSEO" : "OpenRouter", usd(x.usd)))), budgetCard,
    h("div", { class: "cols" },
      h("div", { class: "card" }, h("h2", { style: "margin-top:0" }, "By feature"), u.byFeature.length ? u.byFeature.map((f) => h("div", { class: "sov" }, h("span", {}, f.label), bar(f.usd, maxF), h("span", { class: "num" }, `${usd(f.usd)} · ${f.calls}`))) : h("div", { class: "muted" }, "Nothing spent yet.")),
      p ? null : h("div", { class: "card" }, h("h2", { style: "margin-top:0" }, "By project"), u.byProject.length ? table([{ label: "Project", render: (x) => (x.projectId ? h("a", { href: `#/p/${x.projectId}/usage` }, x.name) : x.name) }, { label: "Spent", render: (x) => usd(x.usd), num: 1 }], u.byProject) : h("div", { class: "muted" }, "Nothing spent yet."))),
    u.daily.length ? h("div", { class: "card" }, h("h2", { style: "margin-top:0" }, "By day"), h("div", { class: "spark" }, u.daily.map((d) => h("div", { class: "col", title: `${d.day}: ${usd(d.usd)}` }, h("i", { style: `height:${maxDay ? Math.max(3, (d.usd / maxDay) * 100) : 3}%` }), h("span", {}, d.day.slice(8)))))) : null,
    h("h2", {}, "Latest billed calls"), table([{ label: "Time (UTC)", render: (x) => x.at.slice(0, 19).replace("T", " ") }, { label: "Provider", key: "provider" }, { label: "Feature", render: (x) => x.feature.replaceAll("_", " ") }, { label: "Endpoint", key: "endpoint" }, { label: "Cost", render: (x) => usd(x.usd), num: 1 }], u.recent, "No billed calls yet."),
    h("p", { class: "muted" }, "CloseSEO has no payments of its own. This is your own spend with DataForSEO and OpenRouter, as reported by them on each call."));
  return h("div", {}, holder);
}
async function usageView() {
  return h("div", {}, h("h1", {}, "Usage & budget"), h("p", { class: "muted" }, h("a", { href: "#/" }, "← Projects")), await usageTab(null));
}

// ---------- router ----------
async function render() {
  const [, , id, tab, sub] = (location.hash || "#/").split("/");
  const is = location.hash.startsWith("#/p/");
  try {
    if (location.hash === "#/usage") return $app.replaceChildren(await usageView());
    if (!is) return $app.replaceChildren(await projectsView());
    if (tab === "audit" && sub) { const { project } = await api(`/api/projects/${id}`); return $app.replaceChildren(h("div", {}, h("h1", {}, project.name), h("nav", { class: "tabs" }, TABS.map(([k, l]) => h("a", { href: `#/p/${id}/${k}`, class: k === "audit" ? "on" : "" }, l))), await auditDetail(project, sub))); }
    $app.replaceChildren(await projectView(id, tab || "dashboard", sub));
  } catch (e) { $app.replaceChildren(h("div", { class: "err" }, e.message), h("a", { href: "#/" }, "← Projects")); }
}
window.addEventListener("hashchange", render);
render();
api("/api/health").then((hh) => { document.getElementById("status").textContent = hh.checks.dataforseo.status === "ok" ? "" : "⚠ DataForSEO key not set"; }).catch(() => {});
