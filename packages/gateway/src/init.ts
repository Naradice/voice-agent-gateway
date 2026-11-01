// 初回設定: トークンを生成し、.env を作る。  npm run gateway:init [-- --device pixel --host 100.x.x.x --port 8787 --force]
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { connectionCode, tokenFingerprint } from "./connection.ts";

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface EnvFileOptions { deviceId: string; token: string; host: string; port: number }

/** .env の内容。VAG_DEVICES は JSON なので単一引用符で囲む。 */
export function buildEnvFile(o: EnvFileOptions): string {
  return [
    "# Voice Agent Gateway の設定。秘密(トークン)を含むので、コミットしない・チャットに貼らない。",
    `VAG_DEVICES='${JSON.stringify([{ deviceId: o.deviceId, token: o.token }])}'`,
    `VAG_HOST=${o.host}`,
    `VAG_PORT=${o.port}`,
    "",
    "# ローカルLLM: 既定は GPU を使わない構成(実験に GPU を空けておくため)。",
    "# 小さいモデルを CPU とメモリだけで動かす。GPU を使わない派生モデルを `npm run ollama:model` で作る(num_gpu 0)。",
    "# 普段使いの Ollama(11434)でそのまま使える。環境変数で GPU を隠す別インスタンス(npm run ollama:cpu)は必須ではない。",
    "LOCAL_MODEL=qwen3-4b-instruct-cpu",
    "LOCAL_DEVICE=cpu           # npm run llm で、本当に GPU を使っていないか確認するための宣言",
    "LOCAL_HISTORY_CHARS=3000   # CPU は長い履歴の処理が遅いので短くする",
    "LOCAL_MAX_TOKENS=300       # 返答を短く打ち切る(音声向け)",
    "VAG_KEEP_ALIVE=10m         # 最後の使用からこの時間でモデルを解放する(メモリを空ける)",
    "# GPU を使う場合(VRAM に余裕があるとき): 上の OLLAMA_BASE_URL〜LOCAL_MAX_TOKENS をコメントアウトし、LOCAL_MODEL=qwen3:14b にする",
    "# LOCAL_CONTEXT=16384      # Ollama に設定した文脈長。入力が迫ると警告する",
    "",
    "# 最新情報の検索(任意)",
    "# SEARCH_PROVIDER=searxng",
    "# SEARXNG_URL=http://127.0.0.1:8080",
    "# SEARCH_PROVIDER=brave",
    "# BRAVE_API_KEY=",
    "",
    "# Codex Desktop のスレッドも扱う場合",
    "# VAG_CODEX=1",
    "",
  ].join("\n");
}

function tailscaleIp(): string | undefined {
  try {
    return execFileSync("tailscale", ["ip", "-4"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).split(/\s+/)[0] || undefined;
  } catch {
    return undefined;
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop()!);
if (isMain) {
  const args = process.argv.slice(2);
  const arg = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const path = process.env.VAG_ENV_FILE ?? ".env";
  if (existsSync(path) && !args.includes("--force")) {
    console.error(`${path} は既にあります。上書きするには --force を付けてください(トークンも作り直されます)。`);
    process.exit(1);
  }
  const host = arg("host") ?? tailscaleIp() ?? "127.0.0.1";
  const token = newToken();
  const deviceId = arg("device") ?? "pixel";
  writeFileSync(path, buildEnvFile({ deviceId, token, host, port: Number(arg("port") ?? 8787) }), { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
  console.log(`${path} を作りました。`);
  console.log(`  待ち受け: ${host}:${arg("port") ?? 8787}${host === "127.0.0.1" ? "  (Tailscale の IP を取得できなかったため。VAG_HOST を編集してください)" : ""}`);
  console.log(`  デバイス: ${deviceId}`);
  console.log(`  確認コード: ${tokenFingerprint(token)}  (アプリの設定画面に出る確認コードと同じなら、トークンの入力は正しい)`);
  console.log("\n接続コード(スマホにコピーして、アプリの「接続コードを貼り付け」で設定できる):");
  console.log(connectionCode(host, Number(arg("port") ?? 8787), token));
  console.log("\nこのコードにはトークンが含まれる。チャットやリポジトリには貼らないでください。後で表示し直すには: npm run gateway:code");
}
