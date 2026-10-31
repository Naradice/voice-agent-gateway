import { AgentError } from "../adapter.ts";
import { ConversationAdapter, type ChatMessage, type ConversationOptions, type ParsedEvent, type TurnParser } from "../conversation.ts";
import { ThinkStripper } from "./think.ts";
import type { OllamaLifecycle } from "./lifecycle.ts";

export interface LocalLLMAdapterOptions extends ConversationOptions {
  /** OpenAI 互換エンドポイントの基点。既定は Ollama の http://127.0.0.1:11434/v1 */
  baseUrl?: string;
  /** 多くのローカル実行基盤では不要 */
  apiKey?: string;
  /** 読み上げ向けの指示 */
  instructions?: string;
  /** 追加の生成パラメータ(temperature 等)をそのまま本文に加える */
  extraBody?: Record<string, unknown>;
  /**
   * 推論モデル(Qwen3 など)の思考を止める。既定 true。
   * 実測(Ollama /v1, qwen3:14b): reasoning_effort:"none" で思考が完全に止まる(446→10トークン)。
   * システム指示の /no_think だけでは止まらなかった(併用しているが、単独では効果なし)。
   * 思考を持たないモデルでは reasoning_effort が拒否される可能性があるため、その場合は false にする。
   * 本文に出た <think>…</think> は常に除去し、delta.reasoning 等の別フィールドは読まない。
   */
  suppressThinking?: boolean;
  /** 指定すると prepare() でモデルを先読みする。常駐させず、使うときだけ読み込むために使う */
  lifecycle?: OllamaLifecycle;
}

/**
 * ローカルLLM(Ollama / llama.cpp server / LM Studio など、OpenAI 互換の /chat/completions を持つ実行基盤)で
 * 日常会話を行う Adapter。会話履歴は Gateway(SQLite)が正本。外部へ発話を送らない。
 * このコードの実行基盤での実機確認はまだ。
 */
export class LocalLLMAdapter extends ConversationAdapter {
  readonly agentType: string;
  private o: LocalLLMAdapterOptions;

  constructor(opts: LocalLLMAdapterOptions) {
    // ローカルモデルは文脈長が短いことが多く、溢れると古い履歴が黙って切り捨てられる。既定で文字数にも上限を置く。
    super({ maxHistoryChars: 8000, ...opts });
    this.o = opts;
    this.agentType = opts.agentType ?? "chat";
  }

  // 読み込み中なら先に知らせる(コールドスタートは数十秒かかることがある)。確認に失敗しても送信は続ける。
  async sendMessage(sessionId: string, text: string): Promise<void> {
    const lc = this.o.lifecycle;
    if (lc) {
      const st = await lc.status().catch(() => undefined);
      if (st && !st.loaded) this.emit({ type: "status", sessionId, code: "model_loading", message: "モデルを起動しています。少しお待ちください" });
    }
    return super.sendMessage(sessionId, text);
  }

  // 使用のたびに Gateway 設定の常駐時間で解放時刻を更新する(Ollama の環境変数の既定値に頼らない)。
  protected onTurnEnd(): void {
    void this.o.lifecycle?.touch().catch(() => {});
  }

  /** PTT が押されたとき等に呼ぶ。発話・音声認識の間にモデルの読み込みを済ませる(ベストエフォート)。 */
  async prepare(): Promise<void> {
    try { await this.o.lifecycle?.warm(); } catch { /* 読み込めなくても会話の要求時に再試行される */ }
  }

  protected endpoint() { return `${this.o.baseUrl ?? "http://127.0.0.1:11434/v1"}/chat/completions`; }

  protected headers() {
    return { "content-type": "application/json", ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) };
  }

  protected body(history: ChatMessage[], context?: string) {
    const system = [this.o.instructions, context, this.o.suppressThinking === false ? undefined : "/no_think"].filter(Boolean).join("\n\n");
    return {
      model: this.o.model,
      messages: [...(system ? [{ role: "system", content: system }] : []), ...history],
      stream: true,
      stream_options: { include_usage: true },
      ...(this.o.suppressThinking === false ? {} : { reasoning_effort: "none" }),
      ...this.o.extraBody, // 上書き可
    };
  }

  protected createParser(): TurnParser {
    const strip = new ThinkStripper();
    return {
      parse: (ev: any): ParsedEvent => {
        if (ev?.error) return { error: new AgentError("unavailable", String(ev.error?.message ?? ev.error), { retryable: true }) };
        const out: ParsedEvent = {};
        const raw = ev?.choices?.[0]?.delta?.content;
        if (typeof raw === "string" && raw) {
          const text = strip.push(raw);
          if (text) out.delta = text;
        }
        if (ev?.usage) out.usage = { inputTokens: ev.usage.prompt_tokens ?? 0, outputTokens: ev.usage.completion_tokens ?? 0 };
        return out;
      },
      flush: () => strip.flush(),
    };
  }

  protected connectError() {
    return new AgentError("unavailable", "ローカルLLMに接続できません。起動しているか確認してください", { retryable: true });
  }

  protected async httpError(res: Response): Promise<AgentError> {
    let message = `local LLM error ${res.status}`;
    try {
      const j: any = await res.json();
      if (j?.error?.message ?? j?.error) message = String(j.error?.message ?? j.error);
    } catch { /* 本文なし */ }
    if (res.status === 404) return new AgentError("not_found", `モデルが見つかりません: ${message}`, { retryable: false });
    if (res.status >= 500 || res.status === 429) return new AgentError("unavailable", message, { retryable: true });
    return new AgentError("protocol", message);
  }
}
