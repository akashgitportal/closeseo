/** Deterministic stand-ins for DataForSEO's ai_optimization endpoints (shared by the fake server). */
type Body = Record<string, any>;
const MODELS: Record<string, string[]> = {
  chat_gpt: ["gpt-5.6-luna", "gpt-5.5", "gpt-4o"],
  claude: ["claude-sonnet-4-5", "claude-sonnet-5", "claude-opus-4"],
  gemini: ["gemini-2.5-pro", "gemini-2.0-flash"],
  perplexity: ["sonar", "sonar-reasoning-pro"],
};
export const AI_CALL_COST = 0.012;
export const AI_MENTIONS_COST = 0.1;

const seen = new Map<string, number>();

/** Returns [result, cost] or a task error, or null when the path is not an AI endpoint. */
export function fakeAi(path: string, body: Body): { result?: unknown; cost?: number; error?: { code: number; message: string } } | null {
  let m = /^\/v3\/ai_optimization\/(chat_gpt|claude|gemini|perplexity)\/llm_responses\/models$/.exec(path);
  if (m) return { result: MODELS[m[1]!]!.map((model_name) => ({ model_name })), cost: 0 };

  m = /^\/v3\/ai_optimization\/(chat_gpt|claude|gemini|perplexity)\/llm_responses\/live$/.exec(path);
  if (m) {
    const slug = m[1]!;
    const prompt = String(body.user_prompt ?? "");
    if (prompt.includes(`[fail:${slug}]`)) return { error: { code: 50000, message: "Internal Error." } };
    if (prompt.includes("[billing]")) return { error: { code: 40200, message: "Payment Required. Not enough funds." } };
    const n = (seen.get(`${slug}|${prompt}`) ?? 0) + 1;
    seen.set(`${slug}|${prompt}`, n);
    // "[nosearch-once]": the first call answers from memory (no search), the paid retry searches
    const searched = body.web_search === true && !(prompt.includes("[nosearch-once]") && n === 1) && !prompt.includes("[nosearch]");
    const brand = prompt.includes("[brand]") ? "Acme" : "Other";
    const annotations = searched ? [
      { type: "url_citation", title: `${brand} guide`, url: `https://www.acme.com/guide-${slug}` },
      { type: "url_citation", title: "Dup", url: `https://www.acme.com/guide-${slug}` },
      { type: "url_citation", title: "Evil", url: "javascript:alert(1)" },
      { type: "url_citation", title: "Creds", url: "https://user:pw@evil.example/x" },
      { type: "url_citation", title: "Review", url: "https://reviews.example.org/best?x=1" },
    ] : [];
    return {
      cost: AI_CALL_COST,
      result: {
        model_name: body.model_name, output_tokens: 321.4, web_search: searched,
        fan_out_queries: searched ? ["best tools", "acme pricing"] : [],
        items: [
          { type: "reasoning", sections: [{ type: "text", text: "hidden thoughts" }] },
          { type: "message", sections: [{ type: "text", text: `${slug} says: ${brand} is a solid choice. C++ fans like it.`, annotations }, { type: "text", text: "Second paragraph." }] },
        ],
        _echo: { web_search_country_iso_code: body.web_search_country_iso_code ?? null, force_web_search: body.force_web_search ?? null, max_output_tokens: body.max_output_tokens },
      },
    };
  }

  if (path.startsWith("/v3/ai_optimization/llm_mentions/")) {
    if (String(body.target?.[0]?.domain ?? body.target?.[0]?.keyword ?? "") === "billing.example") return { error: { code: 40200, message: "Payment Required." } };
    const endpoint = path.split("/")[4];
    const platform = String(body.platform ?? "google");
    const targets: Body[] = endpoint === "cross_aggregated_metrics" ? (body.targets ?? []) : [{ target: body.target }];
    const nameOf = (t: Body) => String(t.target?.[0]?.domain ?? t.target?.[0]?.keyword ?? "");
    const first = nameOf(targets[0] ?? {});
    if (first === "nodata.example" && endpoint !== "cross_aggregated_metrics") return { result: endpoint === "aggregated_metrics" ? { total: { platform: [] } } : { items: [] }, cost: AI_MENTIONS_COST };
    if (first === "partial.example" && endpoint === "top_pages") return { error: { code: 50000, message: "Internal Error." } };
    const base = platform === "chat_gpt" ? 40 : 100;
    switch (endpoint) {
      case "aggregated_metrics":
        return { cost: AI_MENTIONS_COST, result: { total: { platform: [{ type: "platform", key: platform, mentions: base, ai_search_volume: base * 100, impressions: base * 1000 }] } } };
      case "cross_aggregated_metrics":
        return { cost: AI_MENTIONS_COST, result: { items: targets.map((t, i) => ({ key: t.aggregation_key, platform: [{ type: "platform", key: platform, mentions: i === 0 ? base : (i === 1 ? base / 2 : null), ai_search_volume: 100 }] })) } };
      case "top_pages":
        return { cost: AI_MENTIONS_COST, result: { items: [
          { key: `https://www.${first}/pricing`, platform: [{ key: platform, mentions: 12, ai_search_volume: 5000 }] },
          { key: `https://www.${first}/blog/guide`, platform: [{ key: platform, mentions: 7, ai_search_volume: 900 }] },
          { key: `https://other.example/${first}`, platform: [{ key: platform, mentions: 3, ai_search_volume: 100 }] },
          { key: "javascript:alert(1)", platform: [{ key: platform, mentions: 99, ai_search_volume: 99999 }] },
        ] } };
      case "search":
        return { cost: AI_MENTIONS_COST, result: { items: [
          { question: `what is the best ${first}?`, ai_search_volume: 4000, first_response_at: "2026-01-01 00:00:00 +00:00", last_response_at: "2026-03-01 00:00:00 +00:00",
            sources: [{ url: `https://www.${first}/pricing`, title: "Pricing", domain: first }, { url: "javascript:alert(1)", title: "x" }],
            monthly_searches: [{ year: 2026, month: 1, search_volume: 1000 }, { year: 2026, month: 2, search_volume: 1500 }], brand_entities: [{ title: "Acme" }, { title: "Rival" }] },
          { question: `is ${first} worth it`, ai_search_volume: 800, sources: [{ url: `https://www.${first}/blog/guide`, title: "Guide" }],
            monthly_searches: [{ year: 2026, month: 2, search_volume: 500 }, { year: 2026, month: 3, search_volume: null }], brand_entities: [] },
          { question: null, ai_search_volume: 10 },
        ] } };
    }
  }
  return null;
}
