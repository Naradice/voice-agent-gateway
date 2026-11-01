// 思考(考えの文章)がどこに出るか、どの指定で止まるかを切り分ける。Gateway の部品は通さず、ローカルLLMへ直接問い合わせる。
//   npm run diagnose:thinking
// 各条件を1回ずつ、返答の長さに上限(DIAG_MAX_TOKENS、既定 150)をつけて実行する。CPU でも数分で終わる。
// 環境変数: LOCAL_MODEL(既定 qwen3:14b) OLLAMA_BASE_URL(既定 http://127.0.0.1:11434/v1) DIAG_MAX_TOKENS
import { loadDotEnv } from "../src/env.ts";
import { sseEvents } from "../src/openai/sse.ts";

loadDotEnv();

const model = process.env.LOCAL_MODEL ?? "qwen3:14b";
const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1";
const root = baseUrl.replace(/\/v1\/?$/, "");
const cap = Number(process.env.DIAG_MAX_TOKENS ?? 150);
const SYSTEM = "あなたは音声アシスタントです。短く、話し言葉で答えてください。";
const USER = "こんにちは。一言で自己紹介して。";

interface Outcome { totalMs: number; tokens?: number; contentChars: number; thinkingChars: number; head: string }

/** OpenAI 互換の /v1/chat/completions(Gateway が使っている経路)。 */
async function viaCompletions(user: string, extra: Record<string, unknown>): Promise<Outcome> {
  const t0 = Date.now();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model, stream: true, stream_options: { include_usage: true }, max_tokens: cap, ...extra,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
    }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  let content = "", thinking = 0, tokens: number | undefined;
  for await (const ev of sseEvents(res.body)) {
    const d = ev?.choices?.[0]?.delta ?? {};
    const r = d.reasoning ?? d.reasoning_content;
    if (typeof r === "string") thinking += r.length;
    if (typeof d.content === "string") content += d.content;
    if (ev?.usage) tokens = ev.usage.completion_tokens;
  }
  return { totalMs: Date.now() - t0, tokens, contentChars: content.length, thinkingChars: thinking, head: content.trim().slice(0, 70) };
}

/** Ollama のネイティブ API(/api/chat)。think を直接指定でき、考えは message.thinking に分けて返る。 */
async function viaNative(user: string, think: boolean): Promise<Outcome> {
  const t0 = Date.now();
  const res = await fetch(`${root}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: false, think, options: { num_predict: cap }, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j: any = await res.json();
  const content: string = j?.message?.content ?? "";
  return { totalMs: Date.now() - t0, tokens: j?.eval_count, contentChars: content.length, thinkingChars: String(j?.message?.thinking ?? "").length, head: content.trim().slice(0, 70) };
}

const NO_THINK = "\n/no_think";
const variants: { name: string; run: () => Promise<Outcome> }[] = [
  { name: "A 現在の設定: 発話の末尾に /no_think + reasoning_effort:none  (/v1)", run: () => viaCompletions(USER + NO_THINK, { reasoning_effort: "none" }) },
  { name: "B 発話の末尾に /no_think のみ  (/v1)", run: () => viaCompletions(USER + NO_THINK, {}) },
  { name: "C reasoning_effort:none のみ  (/v1)", run: () => viaCompletions(USER, { reasoning_effort: "none" }) },
  { name: "D 何も指定しない  (/v1)", run: () => viaCompletions(USER, {}) },
  { name: "E think:false  (ネイティブ /api/chat)", run: () => viaNative(USER, false) },
  { name: "F think:false + 発話の末尾に /no_think  (ネイティブ /api/chat)", run: () => viaNative(USER + NO_THINK, false) },
];

console.log(`model=${model} base=${baseUrl} 返答の上限=${cap}トークン`);
console.log("読み方: 上限(トークン)に達していたら、考えが続いている。本文の先頭が英語の独り言(Okay, the user…)なら、考えが本文に出ている。\n");
for (const v of variants) {
  try {
    const r = await v.run();
    const hit = r.tokens !== undefined && r.tokens >= cap - 2 ? "  ← 上限に到達" : "";
    console.log(v.name);
    console.log(`  ${(r.totalMs / 1000).toFixed(1)}秒 生成=${r.tokens ?? "?"}トークン${hit} / 本文=${r.contentChars}文字 / 別欄の思考=${r.thinkingChars}文字`);
    console.log(`  本文の先頭: ${JSON.stringify(r.head)}\n`);
  } catch (e) {
    console.log(`${v.name}\n  失敗: ${(e as Error).message}\n`);
  }
}
