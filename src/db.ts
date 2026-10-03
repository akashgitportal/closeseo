import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = DatabaseSync;

const MIGRATIONS: string[] = [
  `CREATE TABLE projects (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, domain TEXT,
     location_code INTEGER NOT NULL DEFAULT 2840, language_code TEXT NOT NULL DEFAULT 'en',
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   );
   CREATE TABLE context_sections (
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     slug TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('standard','custom')),
     title TEXT, content TEXT NOT NULL, updated_at TEXT NOT NULL,
     PRIMARY KEY (project_id, slug)
   );
   CREATE TABLE context_competitors (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     domain TEXT NOT NULL, note TEXT, UNIQUE (project_id, domain)
   );
   CREATE TABLE context_key_pages (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     url TEXT NOT NULL, note TEXT, UNIQUE (project_id, url)
   );
   CREATE TABLE context_research_log (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     note TEXT NOT NULL, created_at TEXT NOT NULL
   );
   CREATE TABLE saved_keywords (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     keyword TEXT NOT NULL, location_code INTEGER NOT NULL, language_code TEXT NOT NULL,
     search_volume INTEGER, keyword_difficulty INTEGER, cpc REAL, competition REAL, intent TEXT,
     monthly_searches TEXT, created_at TEXT NOT NULL,
     UNIQUE (project_id, keyword, location_code, language_code)
   );
   CREATE TABLE saved_keyword_tags (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     name TEXT NOT NULL, color TEXT, UNIQUE (project_id, name)
   );
   CREATE TABLE saved_keyword_tag_assignments (
     saved_keyword_id TEXT NOT NULL REFERENCES saved_keywords(id) ON DELETE CASCADE,
     tag_id TEXT NOT NULL REFERENCES saved_keyword_tags(id) ON DELETE CASCADE,
     PRIMARY KEY (saved_keyword_id, tag_id)
   );
   CREATE TABLE rank_trackers (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     domain TEXT NOT NULL, location_code INTEGER NOT NULL, language_code TEXT NOT NULL,
     location_name TEXT, devices TEXT NOT NULL, serp_depth INTEGER NOT NULL,
     schedule_interval TEXT NOT NULL, schedule_weekday INTEGER, schedule_hour INTEGER,
     schedule_minute INTEGER, schedule_time_zone TEXT, next_run_at TEXT, created_at TEXT NOT NULL
   );
   CREATE TABLE rank_tracker_keywords (
     id TEXT PRIMARY KEY, tracker_id TEXT NOT NULL REFERENCES rank_trackers(id) ON DELETE CASCADE,
     keyword TEXT NOT NULL, match_case INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
     UNIQUE (tracker_id, keyword)
   );
   CREATE TABLE rank_runs (
     id TEXT PRIMARY KEY, tracker_id TEXT NOT NULL REFERENCES rank_trackers(id) ON DELETE CASCADE,
     status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed')),
     trigger TEXT NOT NULL, error_message TEXT, cost_usd REAL NOT NULL DEFAULT 0,
     started_at TEXT, completed_at TEXT, created_at TEXT NOT NULL
   );
   CREATE TABLE rank_snapshots (
     id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES rank_runs(id) ON DELETE CASCADE,
     keyword_id TEXT NOT NULL, keyword TEXT NOT NULL, device TEXT NOT NULL,
     position INTEGER, url TEXT, checked_at TEXT NOT NULL
   );
   CREATE INDEX rank_snapshots_run ON rank_snapshots(run_id);
   CREATE TABLE audits (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     start_url TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled')),
     max_pages INTEGER NOT NULL, pages_crawled INTEGER NOT NULL DEFAULT 0,
     error_message TEXT, started_at TEXT NOT NULL, completed_at TEXT
   );
   CREATE TABLE audit_pages (
     id TEXT PRIMARY KEY, audit_id TEXT NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
     url TEXT NOT NULL, status_code INTEGER, fetch_class TEXT NOT NULL, title TEXT,
     meta_description TEXT, h1_count INTEGER, word_count INTEGER, canonical TEXT,
     noindex INTEGER NOT NULL DEFAULT 0, response_ms INTEGER, depth INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX audit_pages_audit ON audit_pages(audit_id);
   CREATE TABLE audit_issues (
     id TEXT PRIMARY KEY, audit_id TEXT NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
     page_id TEXT, url TEXT NOT NULL, type TEXT NOT NULL,
     severity TEXT NOT NULL CHECK (severity IN ('critical','warning','info')), detail TEXT
   );
   CREATE INDEX audit_issues_audit ON audit_issues(audit_id);
   CREATE TABLE report_templates (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     name TEXT NOT NULL, description TEXT NOT NULL, instructions TEXT NOT NULL,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL
   );
   CREATE TABLE reports (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     title TEXT NOT NULL, summary TEXT NOT NULL, html TEXT NOT NULL, skill TEXT,
     template_id TEXT, share_token TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
   );
   CREATE TABLE kv_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);`,
  // 2: record who last changed shared project memory ("mcp" for agent calls, "user" for the web UI).
  `ALTER TABLE context_sections ADD COLUMN updated_by TEXT NOT NULL DEFAULT 'user';
   ALTER TABLE context_competitors ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
   ALTER TABLE context_competitors ADD COLUMN updated_by TEXT NOT NULL DEFAULT 'user';
   ALTER TABLE context_key_pages ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
   ALTER TABLE context_key_pages ADD COLUMN updated_by TEXT NOT NULL DEFAULT 'user';
   ALTER TABLE context_research_log ADD COLUMN created_by TEXT NOT NULL DEFAULT 'user';`,
  // 3: per-project keyword metrics from research, reused when keywords are saved without explicit metrics.
  `CREATE TABLE keyword_metrics (
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     keyword TEXT NOT NULL, location_code INTEGER NOT NULL, language_code TEXT NOT NULL,
     search_volume INTEGER, cpc REAL, competition REAL, keyword_difficulty INTEGER, intent TEXT,
     monthly_searches TEXT, fetched_at TEXT NOT NULL,
     PRIMARY KEY (project_id, keyword, location_code, language_code)
   );`,
  // 4: rank tracking parity: archive flag, skip reason, per-run totals, per-snapshot SERP features and keyword metrics.
  `ALTER TABLE rank_trackers ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE rank_trackers ADD COLUMN last_skip_reason TEXT;
   ALTER TABLE rank_runs ADD COLUMN keywords_total INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE rank_runs ADD COLUMN keywords_checked INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE rank_snapshots ADD COLUMN serp_features TEXT;
   ALTER TABLE rank_tracker_keywords ADD COLUMN search_volume INTEGER;
   ALTER TABLE rank_tracker_keywords ADD COLUMN keyword_difficulty INTEGER;
   ALTER TABLE rank_tracker_keywords ADD COLUMN cpc REAL;`,
  // 5: report provenance (which client wrote it).
  `ALTER TABLE reports ADD COLUMN created_by TEXT NOT NULL DEFAULT 'app';
   ALTER TABLE reports ADD COLUMN created_by_user_id TEXT NOT NULL DEFAULT 'local-admin';`,
  // 6: Google (Search Console / Analytics): encrypted grants, one-shot OAuth state, per-project connections.
  `CREATE TABLE google_grants (
     id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK (provider IN ('gsc','ga4')),
     account_id TEXT NOT NULL, email TEXT, access_token_enc TEXT NOT NULL, refresh_token_enc TEXT,
     expires_at INTEGER NOT NULL, scope TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
     UNIQUE (provider, account_id)
   );
   CREATE TABLE google_oauth_states (
     state TEXT PRIMARY KEY, provider TEXT NOT NULL, project_id TEXT NOT NULL, code_verifier TEXT NOT NULL,
     redirect_uri TEXT NOT NULL, expires_at INTEGER NOT NULL
   );
   CREATE TABLE gsc_connections (
     project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
     site_url TEXT NOT NULL, grant_id TEXT NOT NULL REFERENCES google_grants(id) ON DELETE CASCADE,
     connected_email TEXT, created_at TEXT NOT NULL
   );
   CREATE TABLE ga4_connections (
     project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
     property_id TEXT NOT NULL, property_display_name TEXT NOT NULL, property_time_zone TEXT NOT NULL,
     property_currency_code TEXT, grant_id TEXT NOT NULL REFERENCES google_grants(id) ON DELETE CASCADE,
     connected_email TEXT, created_at TEXT NOT NULL
   );`,
  // 7: assistant chat sessions (one transcript per session, scoped to a project).
  `CREATE TABLE agent_sessions (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     title TEXT NOT NULL, total_cost_usd REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
   );
   CREATE TABLE agent_messages (
     id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
     seq INTEGER NOT NULL, role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
     content TEXT, tool_calls TEXT, tool_call_id TEXT, tool_name TEXT, cost_usd REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
     UNIQUE (session_id, seq)
   );`,
  // 8: spend ledger, monthly budgets, AI-visibility cache/history, dismissed dashboard steps.
  `CREATE TABLE usage_events (
     id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
     provider TEXT NOT NULL, feature TEXT NOT NULL, endpoint TEXT, cost_usd REAL NOT NULL, created_at TEXT NOT NULL
   );
   CREATE INDEX idx_usage_created ON usage_events(created_at);
   CREATE INDEX idx_usage_project ON usage_events(project_id, created_at);
   CREATE TABLE budgets (
     scope TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
     monthly_limit_usd REAL NOT NULL CHECK (monthly_limit_usd > 0), updated_at TEXT NOT NULL
   );
   CREATE TABLE ai_cache (
     key TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
   );
   CREATE TABLE ai_runs (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('prompt','brand')), query TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
   );
   CREATE INDEX idx_ai_runs_project ON ai_runs(project_id, created_at);
   CREATE TABLE dismissed_steps (
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, step TEXT NOT NULL, created_at TEXT NOT NULL,
     PRIMARY KEY (project_id, step)
   );`,
];

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as
    | { v: number | null }
    | undefined;
  const current = row?.v ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]!);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(i + 1);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return db;
}

export const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();

/** Run fn inside a transaction; rolls back on throw. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
