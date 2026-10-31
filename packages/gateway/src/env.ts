import { existsSync } from "node:fs";

/**
 * .env を読み込む(Node 標準の process.loadEnvFile)。既に設定されている環境変数は上書きしない。
 * 既定の場所はカレントディレクトリの .env。VAG_ENV_FILE で変更できる。
 * 秘密(トークンなど)を含むので .env はコミットしない(.gitignore 済み)。
 */
export function loadDotEnv(path: string = process.env.VAG_ENV_FILE ?? ".env"): boolean {
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}
