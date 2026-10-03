import { Parser } from "htmlparser2";

export type PageAnalysis = {
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  noindex: boolean;
  nofollow: boolean;
  lang: string | null;
  viewport: boolean;
  h1Count: number;
  wordCount: number;
  imagesTotal: number;
  imagesMissingAlt: number;
  links: { href: string; rel: string | null }[];
  insecureResources: string[];
  hasStructuredData: boolean;
  ogTitle: boolean;
};

const SKIP_TEXT = new Set(["script", "style", "noscript", "template", "svg"]);

export function analyzeHtml(html: string): PageAnalysis {
  const out: PageAnalysis = {
    title: null, metaDescription: null, canonical: null, noindex: false, nofollow: false, lang: null,
    viewport: false, h1Count: 0, wordCount: 0, imagesTotal: 0, imagesMissingAlt: 0, links: [],
    insecureResources: [], hasStructuredData: false, ogTitle: false,
  };
  let inTitle = false, titleBuf = "", skipDepth = 0, text = "", inBody = false, ldjson = false;
  const parser = new Parser({
    onopentag(name, a) {
      if (name === "html") out.lang = a.lang?.trim() || null;
      if (name === "body") inBody = true;
      if (name === "title" && out.title === null) { inTitle = true; titleBuf = ""; }
      if (name === "h1") out.h1Count++;
      if (SKIP_TEXT.has(name)) skipDepth++;
      if (name === "script") {
        if ((a.type ?? "").toLowerCase() === "application/ld+json") { out.hasStructuredData = true; ldjson = true; }
        if (a.src?.startsWith("http://")) out.insecureResources.push(a.src);
      }
      if (name === "meta") {
        const n = (a.name ?? a.property ?? "").toLowerCase();
        const c = a.content ?? "";
        if (n === "description" && out.metaDescription === null) out.metaDescription = c.trim();
        if (n === "viewport") out.viewport = true;
        if (n === "og:title") out.ogTitle = true;
        if (n === "robots" || n === "googlebot") {
          const v = c.toLowerCase();
          if (v.includes("noindex") || v.includes("none")) out.noindex = true;
          if (v.includes("nofollow") || v.includes("none")) out.nofollow = true;
        }
      }
      if (name === "link") {
        if ((a.rel ?? "").toLowerCase().split(/\s+/).includes("canonical") && out.canonical === null) out.canonical = a.href?.trim() || null;
        if ((a.rel ?? "").toLowerCase().includes("stylesheet") && a.href?.startsWith("http://")) out.insecureResources.push(a.href);
      }
      if (name === "a" && a.href) out.links.push({ href: a.href.trim(), rel: a.rel ?? null });
      if (name === "img") {
        out.imagesTotal++;
        if (a.alt === undefined || a.alt.trim() === "") out.imagesMissingAlt++;
        if (a.src?.startsWith("http://")) out.insecureResources.push(a.src);
      }
    },
    ontext(t) {
      if (inTitle) titleBuf += t;
      if (inBody && skipDepth === 0) text += ` ${t}`;
    },
    onclosetag(name) {
      if (name === "title" && inTitle) { inTitle = false; out.title = titleBuf.replace(/\s+/g, " ").trim(); }
      if (SKIP_TEXT.has(name) && skipDepth > 0) skipDepth--;
      if (name === "script") ldjson = false;
    },
  }, { decodeEntities: true });
  void ldjson;
  parser.write(html);
  parser.end();
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  out.wordCount = words ? words.length : 0;
  return out;
}

const TEXT_SKIP = new Set(["script", "style", "noscript", "template", "svg", "head"]);

/** Readable text of a page (no scripts/styles), whitespace-collapsed and cut at `max` characters. */
export function extractReadableText(html: string, max = 3000): string {
  let skip = 0, out = "";
  const parser = new Parser({
    onopentag(name) { if (TEXT_SKIP.has(name)) skip++; if (/^(p|div|br|li|h[1-6]|tr|section|article)$/.test(name)) out += "\n"; },
    ontext(t) { if (skip === 0 && out.length < max * 2) out += t; },
    onclosetag(name) { if (TEXT_SKIP.has(name) && skip > 0) skip--; },
  }, { decodeEntities: true });
  parser.write(html);
  parser.end();
  const text = out.replace(/[ \t\r\f]+/g, " ").replace(/\n\s*/g, "\n").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
