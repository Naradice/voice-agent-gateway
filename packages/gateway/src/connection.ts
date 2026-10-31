import { createHash } from "node:crypto";

/**
 * トークンの確認コード(SHA-256 の先頭6桁の16進)。入力ミスの確認用で、トークン本体は画面に出さない。
 * Android アプリの設定画面に出る確認コードと同じ値になる(24ビットなのでトークンの手がかりにはならない)。
 */
export const tokenFingerprint = (token: string): string =>
  createHash("sha256").update(token.trim(), "utf8").digest("hex").slice(0, 6);

/** スマホにコピーして、アプリの「接続コードを貼り付け」で一度に設定するための文字列。 */
export const connectionCode = (host: string, port: number, token: string): string => `ws://${host}:${port}#${token}`;

export interface TokenComparison {
  /** Human-readable explanation of the difference. Never contains characters of either token. */
  summary: string;
  presentedLength: number;
  expectedLength: number;
  /** Zero-based index of the first difference, or null when identical. */
  firstDifferenceIndex: number | null;
}

// Characters that are easy to confuse when a token is typed or read by eye.
const LOOK_ALIKE: Record<string, string> = { O: "0", o: "0", l: "1", I: "1", "|": "1", S: "5", s: "5", B: "8", Z: "2", z: "2" };
const canon = (t: string) => [...t].map((c) => LOOK_ALIKE[c] ?? c).join("");

/**
 * Compare the token a client presented with the one the gateway expects, and say how they differ,
 * so that an authentication failure can be diagnosed from the log instead of guessed at.
 * The output contains only lengths, positions and kinds of difference, never the characters themselves.
 */
export function compareTokens(presented: string, expected: string): TokenComparison {
  const base = { presentedLength: presented.length, expectedLength: expected.length };
  let first: number | null = null;
  for (let i = 0; i < Math.max(presented.length, expected.length); i++) {
    if (presented[i] !== expected[i]) { first = i; break; }
  }
  const result = (summary: string): TokenComparison => ({ ...base, summary, firstDifferenceIndex: first });

  if (presented === expected) return result("tokens are identical");
  if (presented.trim() === expected) return result("presented token has leading or trailing whitespace or a newline");
  const odd = [...presented].findIndex((c) => !/[\x21-\x7e]/.test(c));
  if (odd >= 0) return result(`presented token contains a character outside printable ASCII (full-width, invisible, newline, ...) at position ${odd}`);
  if (presented.length === expected.length && presented.toLowerCase() === expected.toLowerCase()) {
    const where = [...presented].map((c, i) => (c !== expected[i] ? i : -1)).filter((i) => i >= 0);
    const hint = where.length === 1 && where[0] === 0 ? "; only the first character differs, which suggests keyboard auto-capitalization" : "";
    return result(`differs only in letter case (position ${where.slice(0, 5).join(", ")}${where.length > 5 ? ", ..." : ""})${hint}`);
  }
  if (presented.length === expected.length && canon(presented) === canon(expected)) {
    return result("differs only in look-alike characters (0/O, 1/l/I, 5/S, ...)");
  }
  if (presented.length !== expected.length) {
    if (expected.startsWith(presented)) return result(`presented token is truncated: ${expected.length - presented.length} characters shorter than expected, but the beginning matches`);
    if (presented.startsWith(expected)) return result(`presented token has ${presented.length - expected.length} extra characters at the end; the expected token matches the beginning`);
    return result(`different length (presented ${presented.length}, expected ${expected.length}); first difference at position ${first}`);
  }
  const diff = [...presented].filter((c, i) => c !== expected[i]).length;
  return result(`same length, ${diff} character(s) differ (first at position ${first}); probably a different token`);
}
