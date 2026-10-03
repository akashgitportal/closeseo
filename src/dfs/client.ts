import { AppError } from "../errors.ts";

export type DfsCall<T = unknown> = { result: T; costUsd: number; path: string };

type Envelope = {
  status_code?: number;
  status_message?: string;
  cost?: number;
  tasks?: Array<{
    status_code?: number;
    status_message?: string;
    cost?: number;
    result?: unknown[] | null;
  }>;
};

/** Hooks the spend ledger uses: `beforeCall` may throw to refuse a paid call, `onSpend` sees every billed cost. */
export type DfsHooks = {
  beforeCall?: (path: string) => void;
  onSpend?: (path: string, costUsd: number) => void;
};

export type DfsClientOptions = {
  apiKey: string | null;
  baseUrl: string;
  /** Base delay before retrying a temporarily paused call (multiplied by the attempt number). */
  retryDelayMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/**
 * Thin DataForSEO v3 client. `apiKey` is base64("login:password").
 * Every method returns the first task's `result` array plus its USD cost.
 */
export class DfsClient {
  readonly opts: DfsClientOptions;
  hooks: DfsHooks = {};
  /** Queued tasks whose cost has already been reported (DataForSEO bills at task_post; some replies repeat the cost on task_get). */
  private billed = new Set<string>();
  constructor(opts: DfsClientOptions) {
    this.opts = opts;
  }

  get configured() {
    return Boolean(this.opts.apiKey);
  }

  async request<T = unknown[]>(
    path: string,
    body?: unknown,
  ): Promise<DfsCall<T>> {
    // After a burst of calls DataForSEO may pause the account briefly (task code 40201).
    // Refused calls cost nothing, so it is safe to wait a little and try again.
    this.hooks.beforeCall?.(path);
    const MAX_ATTEMPTS = 4; // waits grow 1x, 2x, 4x the base delay (about 21 s with the defaults)
    for (let attempt = 1; ; attempt++) {
      const env = await this.raw(path, body === undefined ? undefined : [body]);
      const task = env.tasks?.[0];
      const code = task?.status_code ?? env.status_code ?? 0;
      const cost = task?.cost ?? env.cost ?? 0;
      if (code === 40201 && attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, (this.opts.retryDelayMs ?? 3000) * 2 ** (attempt - 1)));
        continue;
      }
      if (code !== 20000) throw this.taskError(code, task?.status_message ?? env.status_message ?? "unknown error", path);
      if (cost > 0) this.hooks.onSpend?.(path, cost);
      return { result: (task?.result ?? []) as T, costUsd: cost, path };
    }
  }

  /** Task-level failures carry the provider's own message (it is already human-readable). */
  private taskError(code: number, msg: string, path = ""): AppError {
    if (code === 40201) return new AppError("UPSTREAM_PAUSED", msg);
    if (code === 40101 || code === 40100) return new AppError("UNAUTHENTICATED", msg);
    if ((code === 40200 || code === 40202) && path.startsWith("/v3/ai_optimization")) {
      return new AppError("UPSTREAM_BILLING", "The DataForSEO account has a billing or balance problem");
    }
    if (code === 40200 || code === 40202) {
      return new AppError("UPSTREAM_ERROR", path.startsWith("/v3/backlinks") ? "The DataForSEO account has a billing or balance problem" : msg);
    }
    if (code >= 40500 && code < 40600) return new AppError("VALIDATION_ERROR", msg);
    if (code >= 50000) return new AppError("UPSTREAM_UNAVAILABLE", msg);
    return new AppError("UPSTREAM_ERROR", msg);
  }

  /** One HTTP round trip: auth, transport errors and HTTP-level failures are classified here. */
  private async raw(path: string, payload?: unknown[]): Promise<Envelope> {
    if (!this.opts.apiKey) {
      throw new AppError(
        "NOT_CONFIGURED",
        "DATAFORSEO_API_KEY is not set. It is the base64 of your DataForSEO login:password.",
      );
    }
    const f = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await f(`${this.opts.baseUrl}${path}`, {
        method: payload === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Basic ${this.opts.apiKey}`,
          "Content-Type": "application/json",
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
      });
    } catch (e) {
      throw new AppError(
        "UPSTREAM_UNAVAILABLE",
        `The DataForSEO request did not complete: ${(e as Error).message}`,
      );
    }
    if (!res.ok) {
      // A 403 means the account itself is turned away (e.g. "verify your account"), so surface the reason rather than just the code.
      let why = "";
      if (res.status === 403) {
        try { const b = (await res.json()) as { status_message?: string }; if (b.status_message) why = `: ${b.status_message}`; } catch { /* body is not JSON */ }
      } else await res.body?.cancel().catch(() => undefined);
      throw new AppError(res.status >= 500 ? "UPSTREAM_UNAVAILABLE" : "UPSTREAM_ERROR", `DataForSEO HTTP ${res.status} on ${path}${why}`);
    }
    let env: Envelope;
    try {
      env = (await res.json()) as Envelope;
    } catch (e) {
      throw new AppError("UPSTREAM_ERROR", (e as Error).message);
    }
    return env;
  }

  /** Post several tasks in one request (queued endpoints). Returns one entry per task, in order. */
  async post(path: string, bodies: unknown[]): Promise<{ id: string | null; statusCode: number; message: string }[]> {
    this.hooks.beforeCall?.(path);
    const env = await this.raw(path, bodies);
    for (const t of env.tasks ?? []) {
      const id = (t as { id?: string }).id;
      if (id && (t.cost ?? 0) > 0 && (t.status_code === 20100 || t.status_code === 20000)) {
        this.billed.add(id);
        if (this.billed.size > 20_000) this.billed.delete(this.billed.values().next().value!);
        this.hooks.onSpend?.(path, t.cost!);
      }
    }
    return (env.tasks ?? []).map((t) => ({ id: (t as { id?: string }).id ?? null, statusCode: t.status_code ?? 0, message: t.status_message ?? "" }));
  }

  /** Poll a queued task. `ready:false` while it is still queued or in progress. */
  async getTask<T = Record<string, unknown>>(path: string): Promise<{ ready: boolean; result: T | null; costUsd: number; statusCode: number; message: string }> {
    const env = await this.raw(path);
    const t = env.tasks?.[0];
    const code = t?.status_code ?? 0;
    const taskId = path.split("/").pop() ?? "";
    if (code === 20000 && (t?.cost ?? 0) > 0 && !this.billed.has(taskId)) { this.billed.add(taskId); this.hooks.onSpend?.(path, t!.cost!); }
    return { ready: code === 20000, result: ((t?.result?.[0] as T | undefined) ?? null), costUsd: t?.cost ?? 0, statusCode: code, message: t?.status_message ?? "" };
  }

  /** First result object of a task (most endpoints return exactly one). */
  async first<T = Record<string, unknown>>(path: string, body?: unknown) {
    const r = await this.request<T[]>(path, body);
    return { ...r, result: (r.result[0] ?? null) as T | null };
  }
}
