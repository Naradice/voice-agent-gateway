// ローカルLLMの読み込み状態の確認・先読み・解放。
//   npm run llm -- status | warm | unload
// 実験の前に `unload` すると GPU が空く。環境変数: LOCAL_MODEL(既定 qwen3:14b) OLLAMA_BASE_URL
import { OllamaLifecycle } from "../src/index.ts";
import { deviceVerdict, explainConnectionError, type Device } from "../src/local/cpu.ts";
import { loadDotEnv } from "../src/env.ts";

loadDotEnv();

const model = process.env.LOCAL_MODEL ?? "qwen3:14b";
const lifecycle = new OllamaLifecycle({ model, baseUrl: process.env.OLLAMA_BASE_URL });
const cmd = process.argv[2] ?? "status";

// LOCAL_DEVICE=cpu のとき、GPU を使っていたら警告する(実験のために GPU を空けておく構成の確認)
const expected: Device = process.env.LOCAL_DEVICE === "cpu" ? "cpu" : "gpu";
const show = (s: Awaited<ReturnType<OllamaLifecycle["status"]>>) => {
  const v = deviceVerdict(s, expected);
  console.log(`${model}: ${v.message}${v.ok ? "" : "  <-- 要確認"}`);
  if (s.loaded && s.expiresAt) console.log(`  解放予定: ${s.expiresAt}`);
};

try {
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
} catch (e) {
  const friendly = explainConnectionError(e, process.env.OLLAMA_BASE_URL);
  if (!friendly) throw e;
  console.error(friendly);
  process.exit(1);
}
