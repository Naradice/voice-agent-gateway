const OPEN = "<think>";
const CLOSE = "</think>";

/** buf の末尾が tag の先頭部分と一致する最大の長さ(タグが次のチャンクにまたがる場合に保留する分)。 */
const partialSuffix = (buf: string, tag: string): number => {
  for (let k = Math.min(buf.length, tag.length - 1); k > 0; k--) if (buf.endsWith(tag.slice(0, k))) return k;
  return 0;
};

/**
 * ストリームから <think>…</think> を取り除く。Qwen3 などの推論モデルは思考過程を本文に出すことがあり、
 * 読み上げてはならない。タグがチャンクの途中で切れても正しく扱う。
 */
export class ThinkStripper {
  private inThink = false;
  private buf = "";
  private started = false;

  push(chunk: string): string {
    this.buf += chunk;
    let out = "";
    for (;;) {
      if (this.inThink) {
        const i = this.buf.indexOf(CLOSE);
        if (i < 0) {
          this.buf = this.buf.slice(Math.max(0, this.buf.length - (CLOSE.length - 1)));
          break;
        }
        this.buf = this.buf.slice(i + CLOSE.length);
        this.inThink = false;
      } else {
        const i = this.buf.indexOf(OPEN);
        if (i < 0) {
          const keep = partialSuffix(this.buf, OPEN);
          out += this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(this.buf.length - keep);
          break;
        }
        out += this.buf.slice(0, i);
        this.buf = this.buf.slice(i + OPEN.length);
        this.inThink = true;
      }
    }
    return this.trimLead(out);
  }

  /** 終了時に保留していた分を返す。思考の途中で終わった場合は捨てる。 */
  flush(): string {
    const rest = this.inThink ? "" : this.buf;
    this.buf = "";
    return this.trimLead(rest);
  }

  // 思考ブロックの後ろの空白・改行で応答が始まらないようにする。
  private trimLead(s: string): string {
    if (this.started) return s;
    const t = s.trimStart();
    if (t) this.started = true;
    return t;
  }
}
