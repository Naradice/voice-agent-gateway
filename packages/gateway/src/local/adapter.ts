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
   * 推論モデル(Qwen3 など)の思考を抑える。既定 true。
   * システム指示の末尾に /no_think を足し(Qwen3 のソフトスイッチ)、本文に出た <think>…</think> は必ず除去する。
   * delta.reasoning 等の別フィールドは読まない。思考は読み上げの遅延と誤読の原因になる。
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
      ...this.o.extraBody,
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
