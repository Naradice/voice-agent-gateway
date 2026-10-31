// Speech Formatter (設計書 §4.2, §3.5): Agent の回答から読み上げ用テキストを作る。初期版はルールベース。
// 元の回答は履歴にそのまま残る。ここで作るのは読み上げ用だけ。

const CODE_NOTE = "コードは省略します。";

/** 句点・感嘆・疑問・改行を文の区切りとする(ASCII の "." は小数やURLと区別できないので区切りにしない)。 */
const TERMINATORS = new Set(["。", "！", "？", "!", "?"]);
const CLOSERS = new Set(["」", "』", "）", ")", "”", "\""]);

/** markdown と URL を読み上げに適した形にする。1文でも全体でも使える。 */
export function cleanMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // 画像
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // リンク → 表示文字だけ
    .replace(/https?:\/\/\S+/g, "リンク")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*([-*_]\s*){3,}$/gm, "")
    .replace(/(\*\*|__|\*|_)(\S[^*_]*?)\1/g, "$2")
    .replace(/\|/g, "、")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** 閉じていないものも含め、コードブロックを注記に置き換える。 */
function replaceCodeBlocks(text: string): string {
  let out = "";
  let rest = text;
  for (;;) {
    const open = rest.indexOf("```");
    if (open < 0) return out + rest;
    out += rest.slice(0, open) + CODE_NOTE;
    const close = rest.indexOf("```", open + 3);
    if (close < 0) return out;
    rest = rest.slice(close + 3);
  }
}

export interface FormatOptions {
  /** 読み上げの最大文字数。超えたら文の区切りで切って省略を伝える。既定 300 */
  maxChars?: number;
}

export function formatForSpeech(text: string, opts: FormatOptions = {}): string {
  const max = opts.maxChars ?? 300;
  const flat = cleanMarkdown(replaceCodeBlocks(text))
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (/[。！？!?」]$/.test(l) ? l : l + "。"))
    .join("");
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const end = Math.max(...[...TERMINATORS].map((t) => cut.lastIndexOf(t)));
  return (end > 0 ? cut.slice(0, end + 1) : cut) + "以降は省略します。";
}

/** buffer を、完結した文のリストと、まだ完結していない残りに分ける。 */
function splitComplete(s: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\n") {
      sentences.push(s.slice(start, i));
      start = i + 1;
    } else if (TERMINATORS.has(c)) {
      let j = i + 1;
      while (j < s.length && (TERMINATORS.has(s[j]) || CLOSERS.has(s[j]))) j++;
      // 区切り記号が末尾で終わる場合は、直後の続き(閉じ括弧など)が次のチャンクに来る可能性があるが、文としては完結とみなす
      sentences.push(s.slice(start, j));
      start = j;
      i = j - 1;
    }
  }
  return { sentences: sentences.map((x) => x.trim()).filter(Boolean), rest: s.slice(start) };
}

const trailingBackticks = (s: string): number => (s.endsWith("``") ? 2 : s.endsWith("`") ? 1 : 0);

/**
 * ストリーミングの差分を、文単位の読み上げテキストに変える。
 * これにより、回答の全体が完成する前に最初の文を読み始められる(音声応答の体感遅延を減らす)。
 * コードブロックは読み上げず、一度だけ注記を出す。``` が差分の境目で分断されても正しく扱う。
 */
export class SentenceStream {
  private buf = "";
  private inFence = false;

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const fence = this.buf.indexOf("```");
      if (this.inFence) {
        if (fence < 0) {
          this.buf = this.buf.slice(this.buf.length - trailingBackticks(this.buf));
          break;
        }
        this.buf = this.buf.slice(fence + 3);
        this.inFence = false;
        continue;
      }
      if (fence >= 0) {
        const head = splitComplete(this.buf.slice(0, fence));
        out.push(...head.sentences);
        if (head.rest.trim()) out.push(head.rest.trim());
        out.push(CODE_NOTE);
        this.buf = this.buf.slice(fence + 3);
        this.inFence = true;
        continue;
      }
      const keep = trailingBackticks(this.buf);
      const { sentences, rest } = splitComplete(this.buf.slice(0, this.buf.length - keep));
      out.push(...sentences);
      this.buf = rest + this.buf.slice(this.buf.length - keep);
      break;
    }
    return out.map((s) => cleanMarkdown(s)).filter(Boolean);
  }

  /** ストリーム終了時に、句点のない最後の部分を返す。 */
  flush(): string[] {
    const rest = this.inFence ? "" : cleanMarkdown(this.buf.replace(/`+$/, ""));
    this.buf = "";
    return rest ? [rest.endsWith("。") ? rest : rest + "。"] : [];
  }
}
