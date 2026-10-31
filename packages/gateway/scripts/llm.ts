// ローカルLLMの読み込み状態の確認・先読み・解放。
//   npm run llm -- status | warm | unload
// 実験の前に `unload` すると GPU が空く。環境変数: LOCAL_MODEL(既定 qwen3:14b) OLLAMA_BASE_URL
import { OllamaLifecycle } from "../src/index.ts";
import { loadDotEnv } from "../src/env.ts";

loadDotEnv();

const model = process.env.LOCAL_MODEL ?? "qwen3:14b";
const lifecycle = new OllamaLifecycle({ model, baseUrl: process.env.OLLAMA_BASE_URL });
const cmd = process.argv[2] ?? "status";

const show = (s: Awaited<ReturnType<OllamaLifecycle["status"]>>) => {
  if (!s.loaded) return console.log(`${model}: 解放済み(GPU を使っていません)`);
  const gb = (n?: number) => (n === undefined ? "?" : (n / 1024 ** 3).toFixed(1) + "GB");
  console.log(`${model}: 読み込み中 VRAM=${gb(s.vramBytes)} / 全体=${gb(s.sizeBytes)} (GPU ${s.gpuFraction === undefined ? "?" : Math.round(s.gpuFraction * 100)}%) 解放予定=${s.expiresAt ?? "?"}`);
  if (s.gpuFraction !== undefined && s.gpuFraction < 1) console.log("  注意: 一部が CPU で動いています。GPU が他の用途で埋まっていると遅くなります。");
};

if (cmd === "warm") {
  const r = await lifecycle.warm();
  console.log(`読み込み完了 ${r.loadMs}ms`);
  show(r.status);
} else if (cmd === "unload") {
  await lifecycle.unload();
  show(await lifecycle.status());
} else {
  show(await lifecycle.status());
}
