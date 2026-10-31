import { SearchError, stripHtml, type SearchOptions, type SearchProvider, type SearchResult } from "./types.ts";

export interface BraveOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Brave Search API (Web Search)。ヘッダー X-Subscription-Token、結果は web.results[]。実APIでは未確認。 */
export class BraveSearch implements SearchProvider {
  readonly name = "brave";
  readonly external = true;
  private o: BraveOptions;

  constructor(opts: BraveOptions) {
    this.o = opts;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const url = `${this.o.baseUrl ?? "https://api.search.brave.com"}/res/v1/web/search?q=${encodeURIComponent(query)}&count=${opts.limit ?? 5}`;
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(url, {
        headers: { accept: "application/json", "x-subscription-token": this.o.apiKey },
        signal: opts.signal ?? AbortSignal.timeout(this.o.timeoutMs ?? 8000),
      });
    } catch (e) {
      throw new SearchError("検索サービスに接続できません", { cause: e });
    }
    if (!res.ok) throw new SearchError(`検索サービスがエラーを返しました (${res.status})`);
    const j: any = await res.json().catch(() => ({}));
    return (j?.web?.results ?? []).slice(0, opts.limit ?? 5).map((r: any) => ({
      title: stripHtml(String(r.title ?? "")),
      url: String(r.url ?? ""),
      snippet: stripHtml(String(r.description ?? "")),
    }));
  }
}
