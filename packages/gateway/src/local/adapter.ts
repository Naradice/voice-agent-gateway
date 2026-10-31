import { AgentError } from "../adapter.ts";
import { ConversationAdapter, type ChatMessage, type ConversationOptions, type ParsedEvent } from "../conversation.ts";

export interface LocalLLMAdapterOptions extends ConversationOptions {
  /** OpenAI 互換エンドポイントの基点。既定は Ollama の http://127.0.0.1:11434/v1 */
  baseUrl?: string;
  /** 多くのローカル実行基盤では不要 */
  apiKey?: string;
  /** 読み上げ向けの指示 */
  instructions?: string;
  /** 追加の生成パラメータ(temperature 等)をそのまま本文に加える */
  extraBody?: Record<string, unknown>;
}

/**
 * ローカルLLM(Ollama / llama.cpp server / LM Studio など、OpenAI 互換の /chat/completions を持つ実行基盤)で
 * 日常会話を行う Adapter。会話履歴は Gateway(SQLite)が正本。外部へ発話を送らない。
 * このコードの実行基盤での実機確認はまだ。
 */
export class LocalLLMAdapter extends ConversationAdapter {
  readonly agentType = "local";
  private o: LocalLLMAdapterOptions;

  constructor(opts: LocalLLMAdapterOptions) {
    // ローカルモデルは文脈長が短いことが多く、溢れると古い履歴が黙って切り捨てられる。既定で文字数にも上限を置く。
    super({ maxHistoryChars: 8000, ...opts });
    this.o = opts;
  }

  protected endpoint() { return `${this.o.baseUrl ?? "http://127.0.0.1:11434/v1"}/chat/completions`; }

  protected headers() {
    return { "content-type": "application/json", ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) };
  }

  protected body(history: ChatMessage[]) {
    return {
      model: this.o.model,
      messages: [...(this.o.instructions ? [{ role: "system", content: this.o.instructions }] : []), ...history],
      stream: true,
      stream_options: { include_usage: true },
      ...this.o.extraBody,
    };
  }

  protected parseEvent(ev: any): ParsedEvent {
    if (ev?.error) return { error: new AgentError("unavailable", String(ev.error?.message ?? ev.error), { retryable: true }) };
    const out: ParsedEvent = {};
    const delta = ev?.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta) out.delta = delta;
    if (ev?.usage) out.usage = { inputTokens: ev.usage.prompt_tokens ?? 0, outputTokens: ev.usage.completion_tokens ?? 0 };
    return out;
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
