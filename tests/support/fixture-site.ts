import { createServer, type Server } from "node:http";

const page = (title: string | null, body: string, extra = "") =>
  `<!doctype html><html lang="en"><head>${title === null ? "" : `<title>${title}</title>`}<meta name="viewport" content="width=device-width"><meta name="description" content="Description for ${title ?? "page"}">${extra}</head><body><h1>${title ?? "x"}</h1>${body}<p>${"lorem ipsum dolor sit amet ".repeat(60)}</p></body></html>`;

/** Small deliberately-flawed website used to exercise the site audit. */
export async function startFixtureSite(): Promise<{ url: string; hits: Map<string, number>; close(): Promise<void> }> {
  const hits = new Map<string, number>();
  let origin = "";
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const html = (status: number, body: string) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8" }); res.end(body); };
    const redirect = (to: string) => { res.writeHead(301, { location: to }); res.end(); };
    switch (path) {
      case "/robots.txt": res.writeHead(200, { "content-type": "text/plain" }); return void res.end(`User-agent: *\nDisallow: /private\nSitemap: ${origin}/sitemap.xml\n`);
      case "/sitemap.xml": res.writeHead(200, { "content-type": "application/xml" }); return void res.end(`<?xml version="1.0"?><urlset><url><loc>${origin}/about</loc></url><url><loc>${origin}/only-in-sitemap</loc></url></urlset>`);
      case "/": return html(200, page("Home page of the fixture site", `<a href="/about">about</a> <a href="/dup1">d1</a> <a href="/dup2">d2</a> <a href="/broken">broken</a> <a href="/private/secret">secret</a> <a href="/chain1">chain</a> <a href="/loop-a">loop</a> <a href="/thin">thin</a> <a href="/file.pdf">pdf</a> <a href="/server-error">500</a> <a href="/noindex">noindex</a> <a href="https://external.invalid/x">ext</a> <a href="/many">many</a> <a href="/rate">rate</a> <a href="/nofollow-only" rel="nofollow">nf</a> <a href="mailto:a@b.c">mail</a>`, `<link rel="canonical" href="${origin}/">`));
      case "/about": return html(200, page("About this fixture website", `<a href="/">home</a>`, `<link rel="canonical" href="${origin}/about">`));
      case "/only-in-sitemap": return html(200, page("Only discoverable through the sitemap", ``));
      case "/dup1": case "/dup2": return html(200, page("Duplicate title across pages", ``));
      case "/broken": return html(404, "<h1>nope</h1>");
      case "/private/secret": return html(200, page("Should never be fetched", ""));
      case "/chain1": return redirect("/chain2");
      case "/chain2": return redirect("/chain3");
      case "/chain3": return redirect("/final");
      case "/final": return html(200, page("Final destination after redirects", ""));
      case "/loop-a": return redirect("/loop-b");
      case "/loop-b": return redirect("/loop-a");
      case "/thin": return html(200, `<html><body><p>tiny</p><img src="x.png"></body></html>`);
      case "/file.pdf": res.writeHead(200, { "content-type": "application/pdf" }); return void res.end("%PDF-1.4");
      case "/server-error": return html(500, "boom");
      case "/rate": res.writeHead(429, { "content-type": "text/html" }); return void res.end("slow down");
      case "/noindex": return html(200, page("A page that asks not to be indexed", "", `<meta name="robots" content="noindex">`));
      case "/many": return html(200, page("Many pages hub", Array.from({ length: 60 }, (_, i) => `<a href="/p/${i}">p${i}</a>`).join(" ")));
      default:
        if (path.startsWith("/p/")) return html(200, page(`Generated page ${path.slice(3)} of many`, ""));
        return html(404, "<h1>not found</h1>");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url: origin, hits, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
