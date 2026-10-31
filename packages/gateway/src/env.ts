import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

export interface DotEnvResult {
  loaded: boolean;
  path: string;
  /** .env に書かれているが、すでに設定されている環境変数の値が優先された(.env の値は使われない)キー */
  shadowed: string[];
}

/**
 * .env を読み込む(Node 標準の process.loadEnvFile)。既に設定されている環境変数は上書きしない。
 * 既定の場所はカレントディレクトリの .env。VAG_ENV_FILE で変更できる。
 * 秘密(トークンなど)を含むので .env はコミットしない(.gitignore 済み)。
 */
export function loadDotEnv(path: string = process.env.VAG_ENV_FILE ?? ".env"): DotEnvResult {
  if (!existsSync(path)) return { loaded: false, path, shadowed: [] };
  const parsed = parseEnv(readFileSync(path, "utf8"));
  const shadowed = Object.keys(parsed).filter((k) => process.env[k] !== undefined && process.env[k] !== parsed[k]);
  process.loadEnvFile(path);
  return { loaded: true, path, shadowed };
}

/** shadowed があるときの、利用者向けの説明。 */
export function shadowedMessage(r: DotEnvResult): string | undefined {
  if (r.shadowed.length === 0) return undefined;
  return `${r.path} の次の設定は、環境変数が優先されているため使われていません: ${r.shadowed.join(", ")}\n` +
    "  (以前に set / $env: で設定した値が残っています。.env の値を使うには、このウィンドウで環境変数を消す" +
    "(cmd: set VAG_DEVICES=  のように = の右を空にする)か、新しいウィンドウを開いてください)";
}
