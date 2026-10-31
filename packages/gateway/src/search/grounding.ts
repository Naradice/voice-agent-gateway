import type { SearchProvider, SearchResult } from "./types.ts";

// 最新情報が必要な発話の判定。ルールベース(低遅延・LLM不要)。誤検出すると不要な外部検索が走るので、話題語を要求する。
const FRESH_TOPIC = /天気|気温|降水|降る|ニュース|最新|株価|為替|相場|速報|試合結果|運行情報|遅延|ランキング/;
const EXPLICIT_SEARCH = /検索して|ネットで調べ|ウェブで調べ|web ?で調べ/i;

export function needsSearch(text: string): boolean {
  return FRESH_TOPIC.test(text) || EXPLICIT_SEARCH.test(text);
}

const RULES = [
  "以下は検索結果です。最新情報が必要な質問には、この結果だけを根拠に答えてください。",
  "結果に書かれていないことは推測せず、確認できなかったと伝えてください。",
  "出典はサイト名で一言添え、URLは読み上げないでください。",
].join("");

export function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return "検索結果はありませんでした。推測で答えず、最新情報を確認できなかったと伝えてください。";
  const body = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join("\n\n");
  return `${RULES}\n\n${body}`;
}

export const SEARCH_FAILED =
  "最新情報の検索に失敗しました。推測で答えず、最新情報を確認できなかったと伝えてください。";

export interface GroundingOptions {
  provider: SearchProvider;
  limit?: number;
  /** 検索を行ったときに呼ばれる(利用者への透明性・ログ用。クエリは外部へ送られる) */
  onSearch?: (info: { provider: string; external: boolean; query: string }) => void;
}

/**
 * ConversationAdapter の grounding に渡す関数を作る。
 * 検索が必要な発話だけ検索し、結果を「このターンだけの文脈」として返す。失敗時は推測させない文脈を返す(§5.6)。
 */
export function createGrounding(o: GroundingOptions): (text: string) => Promise<string | undefined> {
  return async (text) => {
    if (!needsSearch(text)) return undefined;
    o.onSearch?.({ provider: o.provider.name, external: o.provider.external, query: text });
    try {
      return formatResults(await o.provider.search(text, { limit: o.limit ?? 5 }));
    } catch {
      return SEARCH_FAILED;
    }
  };
}
