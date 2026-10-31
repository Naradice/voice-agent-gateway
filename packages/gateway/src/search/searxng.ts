import { SearchError, stripHtml, type SearchOptions, type SearchProvider, type SearchResult } from "./types.ts";

export interface SearxngOptions {
  /** 例: http://127.0.0.1:8080。インスタンス側で format=json を有効にしておく必要がある */
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** 自前運用の SearXNG。結果は results[]。自分のマシンで動かす場合でも、SearXNG は各検索エンジンへ問い合わせる。実環境では未確認。 */
export class SearxngSearch implements SearchProvider {
  readonly name = "searxng";
  readonly external = true;
  private o: SearxngOptions;

  constructor(opts: SearxngOptions) {
    this.o = opts;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const url = `${this.o.baseUrl}/search?q=${encodeURIComponent(query)}&format=json&language=ja`;
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(url, { signal: opts.signal ?? AbortSignal.timeout(this.o.timeoutMs ?? 8000) });
    } catch (e) {
      throw new SearchError("検索サービスに接続できません", { cause: e });
    }
    if (!res.ok) throw new SearchError(`検索サービスがエラーを返しました (${res.status})`);
    const j: any = await res.json().catch(() => ({}));
    return (j?.results ?? []).slice(0, opts.limit ?? 5).map((r: any) => ({
      title: stripHtml(String(r.title ?? "")),
      url: String(r.url ?? ""),
      snippet: stripHtml(String(r.content ?? "")),
    }));
  }
}
