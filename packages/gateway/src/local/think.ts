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
 *
 * 開始タグのない </think> も取り除く: Qwen3 は、プロンプト側で思考ブロックが開かれるため、/no_think のとき
 * 出力が「空の思考 → </think> → 答え」の形になる。この閉じタグが読み上げに混ざらないようにする。
 * 限界: 開始タグのないまま長い思考文が出る場合、その文章は取り除けない(閉じタグが来るまで、思考かどうか
 * 判断できず、保留すると音声の遅延が大きくなるため)。思考を出さないモデル・設定を使うこと。
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
        continue;
      }
      const iOpen = this.buf.indexOf(OPEN);
      const iClose = this.buf.indexOf(CLOSE);
      if (iOpen < 0 && iClose < 0) {
        const keep = Math.max(partialSuffix(this.buf, OPEN), partialSuffix(this.buf, CLOSE));
        out += this.buf.slice(0, this.buf.length - keep);
        this.buf = this.buf.slice(this.buf.length - keep);
        break;
      }
      if (iOpen >= 0 && (iClose < 0 || iOpen < iClose)) {
        out += this.buf.slice(0, iOpen);
        this.buf = this.buf.slice(iOpen + OPEN.length);
        this.inThink = true;
      } else {
        // 開始タグのない閉じタグ。タグだけを取り除く。
        out += this.buf.slice(0, iClose);
        this.buf = this.buf.slice(iClose + CLOSE.length);
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
