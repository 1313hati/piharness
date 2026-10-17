/**
 * Web access for the harness: a search tool and a page reader.
 *
 * No API key and no vendor SDK. Search goes through DuckDuckGo's HTML
 * endpoint, or a SearXNG instance when PIHARNESS_SEARCH_URL is set (SearXNG's
 * JSON API is the reliable option if DDG starts serving captchas). Pages are
 * fetched and reduced to text locally.
 *
 * All network entry points take an injectable `fetch`, so the parsers are
 * unit-tested offline against captured HTML.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  maxResults?: number;
  fetchImpl?: typeof fetch;
  /** SearXNG base URL (default: PIHARNESS_SEARCH_URL). */
  searxUrl?: string;
  signal?: AbortSignal;
}

export interface PageResult {
  url: string;
  title: string;
  text: string;
}

export class WebError extends Error {}

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  middot: "·",
  bull: "•",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body.startsWith("#x") || body.startsWith("#X")
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Strip tags/scripts/styles and collapse whitespace. Headings stay as lines. */
export function htmlToText(html: string): string {
  const withoutNoise = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const withBreaks = withoutNoise
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|pre|blockquote|table)>/gi, "\n")
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, level: string) => `\n${"#".repeat(Number(level))} `)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(withBreaks)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? decodeEntities(match[1]).replace(/\s+/g, " ").trim() : "";
}

/** Unwrap DDG's `/l/?uddg=…` redirect and protocol-relative URLs. */
export function normalizeResultUrl(href: string, base = "https://duckduckgo.com"): string {
  let url = decodeEntities(href.trim());
  if (url.startsWith("//")) url = `https:${url}`;
  try {
    const parsed = new URL(url, base);
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) return uddg;
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Parse DuckDuckGo's HTML results page. */
export function parseDuckDuckGo(html: string, maxResults = 5): SearchResult[] {
  const results: SearchResult[] = [];
  const linkRe = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  for (const m of html.matchAll(snippetRe)) {
    snippets.push(decodeEntities(m[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim());
  }
  let i = 0;
  for (const m of html.matchAll(linkRe)) {
    const url = normalizeResultUrl(m[1]);
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (!title || !/^https?:/i.test(url)) continue;
    results.push({ title, url, snippet: snippets[i] ?? "" });
    i += 1;
    if (results.length >= maxResults) break;
  }
  return results;
}

/** Parse SearXNG's JSON payload. */
export function parseSearx(json: unknown, maxResults = 5): SearchResult[] {
  const obj = json as { results?: Array<{ title?: string; url?: string; content?: string }> };
  if (!obj || !Array.isArray(obj.results)) return [];
  return obj.results
    .filter((r) => typeof r.url === "string" && typeof r.title === "string")
    .slice(0, maxResults)
    .map((r) => ({ title: r.title!.trim(), url: r.url!.trim(), snippet: (r.content ?? "").trim() }));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function searchWeb(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
  const q = query.trim();
  if (q.length === 0) throw new WebError("query must be non-empty");
  const maxResults = Math.min(Math.max(opts.maxResults ?? 5, 1), 10);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const searx = opts.searxUrl ?? process.env.PIHARNESS_SEARCH_URL;

  if (searx) {
    const url = `${searx.replace(/\/$/, "")}/search?q=${encodeURIComponent(q)}&format=json`;
    const res = await fetchWithTimeout(url, { headers: { Accept: "application/json", "User-Agent": UA } }, fetchImpl, opts.signal, 20_000);
    if (!res.ok) throw new WebError(`SearXNG returned HTTP ${res.status}`);
    return parseSearx(await res.json(), maxResults);
  }

  const res = await fetchWithTimeout(
    "https://html.duckduckgo.com/html/",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA,
        Accept: "text/html",
      },
      body: new URLSearchParams({ q }).toString(),
    },
    fetchImpl,
    opts.signal,
    20_000,
  );
  if (!res.ok) throw new WebError(`DuckDuckGo returned HTTP ${res.status}`);
  const html = await res.text();
  const results = parseDuckDuckGo(html, maxResults);
  if (results.length === 0) {
    throw new WebError(
      "DuckDuckGo returned no parseable results (captcha or layout change). " +
        "Set PIHARNESS_SEARCH_URL to a SearXNG instance for reliable search.",
    );
  }
  return results;
}

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "::1" || h.endsWith(".localhost")) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

export async function fetchPage(
  url: string,
  opts: { maxChars?: number; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<PageResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebError(`not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WebError(`only http(s) URLs can be fetched, got ${parsed.protocol}`);
  }
  if (isPrivateHost(parsed.hostname) && process.env.PIHARNESS_ALLOW_LOCAL_FETCH !== "1") {
    throw new WebError(`refusing to fetch private host ${parsed.hostname} (set PIHARNESS_ALLOW_LOCAL_FETCH=1 to allow)`);
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchWithTimeout(
    parsed.toString(),
    { headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8" }, redirect: "follow" },
    fetchImpl,
    opts.signal,
    25_000,
  );
  if (!res.ok) throw new WebError(`HTTP ${res.status} ${res.statusText} for ${parsed.toString()}`);

  const type = res.headers.get("content-type") ?? "";
  const raw = await res.text();
  let text: string;
  let title = "";
  if (/text\/html|application\/xhtml/i.test(type) || /^\s*</.test(raw.slice(0, 200))) {
    title = extractTitle(raw);
    text = htmlToText(raw);
  } else {
    text = raw;
  }
  const maxChars = opts.maxChars ?? 12_000;
  const truncated = text.length > maxChars;
  return {
    url: parsed.toString(),
    title,
    text: truncated ? `${text.slice(0, maxChars)}\n… [truncated ${text.length - maxChars} chars]` : text,
  };
}
