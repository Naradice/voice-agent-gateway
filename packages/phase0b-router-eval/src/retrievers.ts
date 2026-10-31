import type { SessionIndex } from "../../shared/src/types.ts";

export interface Scored { s: SessionIndex; score: number }
/** pool 内のセッションを発話との関連度で並べる(関連度 0 は含めない)。 */
export type Retriever = (utterance: string, pool: SessionIndex[]) => Scored[];

/** 方式A: キーワード一致数。 */
export const keywordRetriever: Retriever = (utterance, pool) =>
  pool
    .map((s) => ({ s, score: s.keywords.filter((k) => utterance.toLowerCase().includes(k.toLowerCase())).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

const grams = (t: string): string[] => {
  const s = t.toLowerCase().replace(/[\s、。,.!?！？「」()（）]/g, "");
  if (s.length < 2) return s ? [s] : [];
  return Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2));
};

/**
 * 方式Bの代用: 文字2-gram の TF-IDF コサイン類似度。
 * 本物の Embedding モデルではない(語の意味的近さは捉えられない)。
 * Ollama 等の Embedding を入れる前の、オフラインで動く下限ベースライン。
 */
export function tfidfRetriever(sessions: SessionIndex[], minScore = 0.05): Retriever {
  const text = (s: SessionIndex) => [s.title, s.summary, ...s.keywords].join(" ");
  const docs = sessions.map((s) => new Set(grams(text(s))));
  const df = new Map<string, number>();
  for (const d of docs) for (const g of d) df.set(g, (df.get(g) ?? 0) + 1);
  const N = sessions.length;
  const idf = (g: string) => Math.log((N + 1) / ((df.get(g) ?? 0) + 1)) + 1;
  const vec = (gs: Iterable<string>) => {
    const v = new Map<string, number>();
    for (const g of new Set(gs)) v.set(g, idf(g));
    return v;
  };
  const norm = (v: Map<string, number>) => Math.sqrt([...v.values()].reduce((a, x) => a + x * x, 0));
  const docVec = new Map(sessions.map((s, i) => [s.id, vec(docs[i])]));

  return (utterance, pool) => {
    const q = vec(grams(utterance));
    const qn = norm(q);
    if (!qn) return [];
    return pool
      .map((s) => {
        const d = docVec.get(s.id)!;
        let dot = 0;
        for (const [g, w] of q) dot += w * (d.get(g) ?? 0);
        return { s, score: dot / (qn * norm(d)) };
      })
      .filter((x) => x.score >= minScore)
      .sort((a, b) => b.score - a.score);
  };
}
