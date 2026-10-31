export interface SearchResult { title: string; url: string; snippet: string }

export interface SearchOptions { limit?: number; signal?: AbortSignal }

/** 検索プロバイダ。クエリ文字列は外部サービスへ送られる(§9.3: 送信先は利用者が把握できること)。 */
export interface SearchProvider {
  /** 設定画面・ログ用の名前 */
  readonly name: string;
  /** true なら、クエリがインターネット上の第三者サービスへ送られる */
  readonly external: boolean;
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
}

export class SearchError extends Error {
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = "SearchError";
  }
}

export const stripHtml = (s: string): string =>
  s.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").trim();
