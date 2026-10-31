import { createHash } from "node:crypto";

/**
 * トークンの確認コード(SHA-256 の先頭6桁の16進)。入力ミスの確認用で、トークン本体は画面に出さない。
 * Android アプリの設定画面に出る確認コードと同じ値になる(24ビットなのでトークンの手がかりにはならない)。
 */
export const tokenFingerprint = (token: string): string =>
  createHash("sha256").update(token.trim(), "utf8").digest("hex").slice(0, 6);

/** スマホにコピーして、アプリの「接続コードを貼り付け」で一度に設定するための文字列。 */
export const connectionCode = (host: string, port: number, token: string): string => `ws://${host}:${port}#${token}`;
