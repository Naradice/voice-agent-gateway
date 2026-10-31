// GPU を使わない Ollama を別ポートで起動する。会話モデルを CPU とメモリだけで動かし、GPU を実験に空けておくため。
//   npm run ollama:cpu
// 普段使いの Ollama(GPU を使う 11434)には影響しない。モデルのファイルは共有される。
//   接続先: OLLAMA_BASE_URL のポート(未設定なら 11435)。Gateway の .env に OLLAMA_BASE_URL=http://127.0.0.1:11435/v1 を設定する。
//   OLLAMA_BIN で ollama の実行ファイルを指定できる。VAG_CPU_PRIORITY=normal で優先度を下げない(既定は下げる)。
import { spawn } from "node:child_process";
import { constants, setPriority } from "node:os";
import { loadDotEnv } from "../src/env.ts";
import { CPU_OLLAMA_PORT, cpuOnlyEnv, portOf } from "../src/local/cpu.ts";

loadDotEnv();
const port = portOf(process.env.OLLAMA_BASE_URL, CPU_OLLAMA_PORT);
const bin = process.env.OLLAMA_BIN ?? "ollama";

console.log(`CPU 専用の Ollama を起動します: 127.0.0.1:${port}(GPU は使いません)`);
console.log(`  Gateway の .env: OLLAMA_BASE_URL=http://127.0.0.1:${port}/v1  LOCAL_DEVICE=cpu`);
console.log(`  確認: npm run llm -- warm   → 「CPU のみで動いています」と出れば成功`);
console.log(`  モデルの取得(未取得なら。別ウィンドウで): set OLLAMA_HOST=127.0.0.1:${port}  →  ollama pull qwen3:4b`);
console.log("  止めるには Ctrl+C。\n");

const child = spawn(bin, ["serve"], {
  env: cpuOnlyEnv(process.env, port),
  stdio: "inherit",
  shell: process.platform === "win32" && !process.env.OLLAMA_BIN,
});

// 実験の CPU を奪わないよう、優先度を下げる(子プロセスは親の優先度を引き継ぐ)。応答が遅くなる代わりに、実験を優先する。
if (child.pid && process.env.VAG_CPU_PRIORITY !== "normal") {
  try { setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* 設定できなくても動作はする */ }
}

child.on("error", (e) => { console.error(`ollama を起動できません: ${e.message}\nollama が PATH にあるか確認してください(OLLAMA_BIN で指定もできます)`); process.exit(1); });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill());
