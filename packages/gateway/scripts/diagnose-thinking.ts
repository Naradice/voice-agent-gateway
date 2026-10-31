// 初回トークンの遅さの原因が「思考」かを切り分ける。Gateway の部品は通さず、ローカルLLMへ直接ストリーミングで問い合わせて
// 思考(別フィールドまたは <think> タグ)と本文それぞれの量と到着時間を測る。各条件を2回実行し、2回目(ウォーム)を表示する。
// 環境変数: LOCAL_MODEL(既定 qwen3:14b) OLLAMA_BASE_URL(既定 http://127.0.0.1:11434/v1)
import { sseEvents } from "../src/openai/sse.ts";

const model = process.env.LOCAL_MODEL ?? "qwen3:14b";
const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1";

const variants: { name: string; system: string; extra: Record<string, unknown> }[] = [
  { name: "A 現在の設定 (/no_think)", system: "短く答えてください。\n\n/no_think", extra: {} },
  { name: "B /no_think + reasoning_effort:none", system: "短く答えてください。\n\n/no_think", extra: { reasoning_effort: "none" } },
  { name: "C 指定なし(思考の量を見る基準)", system: "短く答えてください。", extra: {} },
];

async function run(system: string, extra: Record<string, unknown>) {
  const t0 = Date.now();
  let firstAny: number | undefined, firstContent: number | undefined;
  let reasoningChars = 0, contentChars = 0, thinkTagChars = 0, completionTokens: number | undefined;
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model, stream: true, stream_options: { include_usage: true }, ...extra,
      messages: [{ role: "system", content: system }, { role: "user", content: "こんにちは。一言で自己紹介して。" }],
    }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  let raw = "";
  for await (const ev of sseEvents(res.body)) {
    const d = ev?.choices?.[0]?.delta ?? {};
    const reasoning = d.reasoning ?? d.reasoning_content;
    if (typeof reasoning === "string" && reasoning) { firstAny ??= Date.now() - t0; reasoningChars += reasoning.length; }
    if (typeof d.content === "string" && d.content) { firstAny ??= Date.now() - t0; raw += d.content; contentChars += d.content.length; }
    if (ev?.usage) completionTokens = ev.usage.completion_tokens;
  }
  for (const m of raw.matchAll(/<think>[\s\S]*?<\/think>/g)) thinkTagChars += m[0].length;
  const visible = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (visible) firstContent = undefined; // 本文の到着時刻はタグ除去後に決まるため、全体時間で代用する
  return { totalMs: Date.now() - t0, firstAnyMs: firstAny, reasoningChars, thinkTagChars, visibleChars: visible.length, completionTokens };
}

console.log(`model=${model} base=${baseUrl}`);
for (const v of variants) {
  try {
    await run(v.system, v.extra); // ウォームアップ
    const r = await run(v.system, v.extra);
    console.log(`\n${v.name}`);
    console.log(`  全体=${r.totalMs}ms 最初の出力(思考含む)=${r.firstAnyMs}ms`);
    console.log(`  別フィールドの思考=${r.reasoningChars}文字 本文内<think>=${r.thinkTagChars}文字 見える本文=${r.visibleChars}文字 生成トークン=${r.completionTokens}`);
  } catch (e) {
    console.log(`\n${v.name}\n  失敗: ${(e as Error).message}`);
  }
}
console.log("\n読み方: 生成トークンが見える本文に比べて多く、思考の文字数が多ければ、思考が遅延の原因です。");
