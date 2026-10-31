import { test } from "node:test";
import assert from "node:assert/strict";
import { BraveSearch, SearxngSearch, SearchError, createGrounding, needsSearch, SEARCH_FAILED, type SearchProvider } from "../src/index.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("needsSearch: fresh-info topics and explicit requests only", () => {
  for (const t of ["今日の天気は？", "最新のニュースを教えて", "ドル円の為替は", "ネットで調べて", "電車の遅延情報"]) assert.ok(needsSearch(t), t);
  for (const t of ["こんにちは", "今日の夕飯何にしよう", "JEPAの論文の要点", "その話の続き"]) assert.ok(!needsSearch(t), t);
});

test("Brave: sends the key as a header (never in the URL), maps results, strips HTML", async () => {
  let seen: { url: string; headers: any } | undefined;
  const brave = new BraveSearch({
    apiKey: "brave-secret",
    fetch: (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers };
      return json({ web: { results: [{ title: "<b>東京</b>の天気", url: "https://ex.jp/w", description: "晴れ &amp; 暑い" }, { title: "b", url: "https://ex.jp/b", description: "d" }] } });
    }) as typeof fetch,
  });
  const r = await brave.search("東京 天気", { limit: 1 });
  assert.deepEqual(r, [{ title: "東京の天気", url: "https://ex.jp/w", snippet: "晴れ & 暑い" }]);
  assert.ok(!seen!.url.includes("brave-secret"));
  assert.equal(seen!.headers["x-subscription-token"], "brave-secret");
  assert.ok(seen!.url.includes(encodeURIComponent("東京 天気")));
});

test("SearXNG: requests format=json and maps content to snippet", async () => {
  let url = "";
  const s = new SearxngSearch({ baseUrl: "http://127.0.0.1:8080", fetch: (async (u: string) => { url = u; return json({ results: [{ title: "t", url: "https://x", content: "c" }] }); }) as typeof fetch });
  assert.deepEqual(await s.search("q"), [{ title: "t", url: "https://x", snippet: "c" }]);
  assert.ok(url.startsWith("http://127.0.0.1:8080/search?") && url.includes("format=json"));
});

test("provider failures surface as SearchError (HTTP error and network error)", async () => {
  const http = new BraveSearch({ apiKey: "k", fetch: (async () => json({}, 429)) as typeof fetch });
  await assert.rejects(http.search("q"), (e: unknown) => e instanceof SearchError && /429/.test(e.message));
  const net = new SearxngSearch({ baseUrl: "http://x", fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
  await assert.rejects(net.search("q"), SearchError);
});

test("grounding: skips search for ordinary chat, includes results otherwise, and never invites guessing on failure", async () => {
  const queries: string[] = [];
  const ok: SearchProvider = { name: "fake", external: true, search: async (q) => { queries.push(q); return [{ title: "気象庁", url: "https://jma.go.jp", snippet: "東京は晴れ" }]; } };
  const notified: string[] = [];
  const g = createGrounding({ provider: ok, onSearch: (i) => notified.push(`${i.provider}:${i.external}`) });
  assert.equal(await g("こんにちは"), undefined);
  assert.deepEqual(queries, []);
  const ctx = await g("今日の天気は？");
  assert.ok(ctx!.includes("気象庁") && ctx!.includes("東京は晴れ") && ctx!.includes("推測せず"));
  assert.deepEqual(notified, ["fake:true"]);

  const bad: SearchProvider = { name: "bad", external: true, search: async () => { throw new SearchError("down"); } };
  assert.equal(await createGrounding({ provider: bad })("今日の天気は？"), SEARCH_FAILED);
  const empty: SearchProvider = { name: "empty", external: true, search: async () => [] };
  assert.ok((await createGrounding({ provider: empty })("最新のニュース"))!.includes("確認できなかった"));
});
