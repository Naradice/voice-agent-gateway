// ローカルLLM(既定: Ollama + qwen3:14b)の疎通確認。Gateway の部品をそのまま通して次を調べる:
//   1. 日本語の短い応答がストリーミングで返るか(初回トークンまでの時間、使用トークン、思考タグの混入)
//   2. 履歴がモデルの文脈長で黙って切られていないか(合言葉テスト)
//   3. 検索設定があれば、検索 → 回答の流れ
// 環境変数: LOCAL_MODEL(既定 qwen3:14b) OLLAMA_BASE_URL(既定 http://127.0.0.1:11434/v1)
//           PROBE_CHARS(合言葉テストの履歴量。既定 6000)
//           SEARCH_PROVIDER=brave|searxng, BRAVE_API_KEY / SEARXNG_URL
import { BraveSearch, LocalLLMAdapter, SearxngSearch, Store, createGrounding, type AgentEvent } from "../src/index.ts";

const model = process.env.LOCAL_MODEL ?? "qwen3:14b";
const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1";
const probeChars = Number(process.env.PROBE_CHARS ?? 6000);

const provider =
  process.env.SEARCH_PROVIDER === "brave" ? new BraveSearch({ apiKey: process.env.BRAVE_API_KEY ?? "" })
  : process.env.SEARCH_PROVIDER === "searxng" ? new SearxngSearch({ baseUrl: process.env.SEARXNG_URL ?? "http://127.0.0.1:8080" })
  : undefined;

const store = new Store();
const adapter = new LocalLLMAdapter({
  store, model, baseUrl,
  instructions: "あなたは音声アシスタントです。短く、話し言葉で答えてください。コードや長いURLは読み上げません。",
  maxHistoryMessages: 1000,
  maxHistoryChars: 1_000_000, // 切り詰めはサーバー側で起きていないかを見たいので、Gateway 側では切らない
  grounding: provider && createGrounding({ provider, onSearch: (i) => console.log(`  [検索] ${i.provider} (外部送信=${i.external}) に問い合わせ: ${i.query}`) }),
});

async function turn(sessionId: string, text: string) {
  const t0 = Date.now();
  let first: number | undefined;
  let answer = "";
  const done = new Promise<AgentEvent>((resolve) => {
    const off = adapter.subscribe(sessionId, (e) => {
      if (e.type === "message.delta") { first ??= Date.now() - t0; answer += e.text; }
      if (e.type === "turn.completed") { off(); resolve(e); }
    });
  });
  await adapter.sendMessage(sessionId, text);
  const end = (await done) as Extract<AgentEvent, { type: "turn.completed" }>;
  return { answer, status: end.status, error: end.error, firstMs: first, totalMs: Date.now() - t0 };
}

const usageNow = () => store.usageTotals();

console.log(`model=${model} base=${baseUrl}`);

// 1. 短い応答
{
  const s = await adapter.createSession("smoke");
  const r = await turn(s.id, "こんにちは。一言で自己紹介して。");
  console.log("\n[1] 短い応答");
  console.log(`  status=${r.status} 初回トークン=${r.firstMs}ms 全体=${r.totalMs}ms`);
  console.log(`  回答: ${r.answer}`);
  if (r.error) console.log(`  エラー: ${r.error.kind} ${r.error.message}`);
  console.log(`  思考タグの混入: ${/<\/?think>/.test(r.answer) ? "あり(要調査)" : "なし"}  使用: ${JSON.stringify(usageNow())}`);
}

// 2. 合言葉テスト
{
  const s = await adapter.createSession("context-probe");
  store.addMessage(s.id, "user", "合言葉は『青いカモメ』です。覚えてください。");
  store.addMessage(s.id, "assistant", "覚えました。");
  const filler = "これは文脈長を確認するための埋め草の文章です。内容に意味はありません。";
  let n = 0;
  while (n < probeChars) {
    store.addMessage(s.id, "user", filler);
    store.addMessage(s.id, "assistant", "はい。");
    n += filler.length + 3;
  }
  const before = usageNow().inputTokens;
  const r = await turn(s.id, "最初に教えた合言葉は何でしたか？");
  const promptTokens = usageNow().inputTokens - before;
  console.log(`\n[2] 合言葉テスト(履歴 約${n}文字)`);
  console.log(`  status=${r.status} 入力トークン=${promptTokens} 回答: ${r.answer}`);
  console.log(`  合言葉の想起: ${r.answer.includes("青いカモメ") ? "成功" : "失敗(履歴が切られている可能性。コンテキスト長を確認)"}`);
  console.log("  入力トークンが 2048 / 4096 付近で頭打ちなら、サーバーの既定の文脈長で切られています。");
}

// 3. 検索
if (provider) {
  const s = await adapter.createSession("search");
  const r = await turn(s.id, "今日の東京の天気を教えて");
  console.log("\n[3] 検索を使った回答");
  console.log(`  status=${r.status} 全体=${r.totalMs}ms`);
  console.log(`  回答: ${r.answer}`);
} else {
  console.log("\n[3] 検索: SEARCH_PROVIDER が未設定のためスキップ");
}
