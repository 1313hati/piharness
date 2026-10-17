import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeEntities, extractTitle, fetchPage, htmlToText, normalizeResultUrl,
  parseDuckDuckGo, parseSearx, searchWeb, WebError,
} from "../src/extensions/web.js";

const DDG_HTML = `
<html><body>
  <div class="result results_links">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Ftest%2F&amp;rut=abc">Node.js test runner &amp; docs</a>
    </h2>
    <a class="result__snippet" href="#">The <b>node:test</b> module&#x27;s API.</a>
  </div>
  <div class="result results_links">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://example.com/guide">A guide — part 2</a>
    </h2>
    <a class="result__snippet" href="#">How to structure tests.</a>
  </div>
</body></html>`;

test("web: entity decoding handles named, decimal and hex forms", () => {
  assert.equal(decodeEntities("a &amp; b &lt;c&gt; &#39;q&#x27; &hellip; &nbsp;x"), "a & b <c> 'q' …  x");
  assert.equal(decodeEntities("&unknown; stays"), "&unknown; stays");
});

test("web: htmlToText drops scripts/styles and keeps structure", () => {
  const html = `<html><head><title>Hi &amp; bye</title><style>.a{}</style></head>
    <body><script>alert(1)</script><h1>Title</h1><p>One   two</p><ul><li>a</li><li>b</li></ul></body></html>`;
  assert.equal(extractTitle(html), "Hi & bye");
  const text = htmlToText(html);
  assert.match(text, /^# Title$/m);
  assert.match(text, /^One two$/m);
  assert.match(text, /^- a$/m);
  assert.doesNotMatch(text, /alert|\.a\{/);
});

test("web: DDG parser unwraps redirects and pairs snippets", () => {
  const results = parseDuckDuckGo(DDG_HTML, 5);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, "https://nodejs.org/api/test/");
  assert.equal(results[0].title, "Node.js test runner & docs");
  assert.equal(results[0].snippet, "The node:test module's API.");
  assert.equal(results[1].url, "https://example.com/guide");
});

test("web: normalizeResultUrl leaves plain URLs alone", () => {
  assert.equal(normalizeResultUrl("https://a.example/x?y=1"), "https://a.example/x?y=1");
  assert.equal(normalizeResultUrl("//a.example/x"), "https://a.example/x");
});

test("web: SearXNG JSON parsing", () => {
  const results = parseSearx({ results: [{ title: "T", url: "https://e.x", content: "S" }] }, 3);
  assert.deepEqual(results, [{ title: "T", url: "https://e.x", snippet: "S" }]);
  assert.deepEqual(parseSearx({}, 3), []);
});

test("web: searchWeb posts the query and parses DDG", async () => {
  let seen: { url: string; body?: string } | null = null;
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), body: String(init?.body ?? "") };
    return new Response(DDG_HTML, { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;

  const results = await searchWeb("node test runner", { fetchImpl: fakeFetch });
  assert.equal(seen!.url, "https://html.duckduckgo.com/html/");
  assert.equal(seen!.body, "q=node+test+runner");
  assert.equal(results.length, 2);
});

test("web: searchWeb uses SearXNG when configured", async () => {
  let url = "";
  const fakeFetch = (async (u: string | URL | Request) => {
    url = String(u);
    return new Response(JSON.stringify({ results: [{ title: "A", url: "https://a", content: "b" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const results = await searchWeb("q", { fetchImpl: fakeFetch, searxUrl: "http://search.local/" });
  assert.equal(url, "http://search.local/search?q=q&format=json");
  assert.equal(results[0].title, "A");
});

test("web: fetchPage reduces HTML to text and truncates", async () => {
  const fakeFetch = (async () =>
    new Response(`<html><head><title>Doc</title></head><body><p>${"x".repeat(500)}</p></body></html>`, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })) as typeof fetch;

  const page = await fetchPage("https://example.com/doc", { fetchImpl: fakeFetch, maxChars: 100 });
  assert.equal(page.title, "Doc");
  assert.match(page.text, /truncated 40\d chars/);
});

test("web: fetchPage refuses private hosts and non-http schemes", async () => {
  await assert.rejects(() => fetchPage("http://127.0.0.1:8080/x"), WebError);
  await assert.rejects(() => fetchPage("file:///etc/passwd"), WebError);
});

test("web: HTTP failure becomes a WebError", async () => {
  const fakeFetch = (async () => new Response("nope", { status: 503, statusText: "Service Unavailable" })) as typeof fetch;
  await assert.rejects(() => fetchPage("https://example.com", { fetchImpl: fakeFetch }), /503/);
});
