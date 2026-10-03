import { createServer, type Server } from "node:http";

/** Scriptable OpenAI-compatible chat endpoint. Tests queue the model's next replies; every request is recorded. */
export type FakeOpenRouter = {
  url: string; close(): Promise<void>;
  script(...replies: Reply[]): void;
  requests(): any[];
  reset(): void;
};
export type Reply =
  | { text: string; cost?: number }
  | { tools: { name: string; args: unknown; id?: string }[]; text?: string; cost?: number }
  | { http: number; body?: unknown; delayMs?: number }
  | { raw: string };

export async function startFakeOpenRouter(opts: { apiKey: string }): Promise<FakeOpenRouter> {
  let queue: Reply[] = [];
  let seen: any[] = [];
  let n = 0;
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    if (req.url !== "/chat/completions") { res.writeHead(404); return void res.end(); }
    if (req.headers.authorization !== `Bearer ${opts.apiKey}`) { res.writeHead(401, { "content-type": "application/json" }); return void res.end(JSON.stringify({ error: { message: "No auth credentials found", code: 401 } })); }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    seen.push(body);
    const r = queue.shift() ?? { text: "(no scripted reply)" };
    if ("http" in r) { if (r.delayMs) await new Promise((x) => setTimeout(x, r.delayMs)); res.writeHead(r.http, { "content-type": "application/json" }); return void res.end(JSON.stringify(r.body ?? { error: { message: `scripted ${r.http}` } })); }
    if ("raw" in r) { res.writeHead(200, { "content-type": "application/json" }); return void res.end(r.raw); }
    const cost = r.cost ?? 0.0004;
    const message = "tools" in r
      ? { role: "assistant", content: r.text ?? null, tool_calls: r.tools.map((t) => ({ id: t.id ?? `call_${++n}`, type: "function", function: { name: t.name, arguments: typeof t.args === "string" ? t.args : JSON.stringify(t.args) } })) }
      : { role: "assistant", content: r.text };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: `gen-${++n}`, model: body.model, choices: [{ index: 0, finish_reason: "tools" in r ? "tool_calls" : "stop", message }], usage: { prompt_tokens: 1000, completion_tokens: 50, cost } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }), script: (...r) => { queue.push(...r); }, requests: () => seen, reset() { queue = []; seen = []; } };
}
