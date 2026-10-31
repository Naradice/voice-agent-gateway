import { AgentError } from "../adapter.ts";
import { ConversationAdapter, type ChatMessage, type ConversationOptions, type ParsedEvent, type TurnParser } from "../conversation.ts";

export interface OpenAIAdapterOptions extends ConversationOptions {
  apiKey: string;
  baseUrl?: string;
  /** 読み上げ向けの指示(簡潔に、コードや長いURLを読み上げない等) */
  instructions?: string;
  /** 最新情報が必要な質問用(§5.6)。ツール種別名は未検証のため、有効化時は webSearchToolType で指定可 */
  webSearch?: boolean;
  webSearchToolType?: string;
}

/**
 * OpenAI Responses API を使う、オプションのオンライン接続先(既定の会話先はローカルLLM)。
 * ChatGPT 公式アプリの会話とは同期しない。イベント名は公式ドキュメントに基づく仮定で、実APIでは未確認。
 */
export class OpenAIAdapter extends ConversationAdapter {
  readonly agentType: string;
  private o: OpenAIAdapterOptions;

  constructor(opts: OpenAIAdapterOptions) {
    super(opts);
    this.o = opts;
    this.agentType = opts.agentType ?? "openai";
  }

  protected endpoint() { return `${this.o.baseUrl ?? "https://api.openai.com/v1"}/responses`; }
  protected headers() { return { authorization: `Bearer ${this.o.apiKey}`, "content-type": "application/json" }; }

  protected body(history: ChatMessage[], context?: string) {
    const instructions = [this.o.instructions, context].filter(Boolean).join("\n\n");
    return {
      model: this.o.model,
      input: history,
      stream: true,
      store: false, // 会話の正本は Gateway。OpenAI 側には保存させない
      ...(instructions ? { instructions } : {}),
      ...(this.o.webSearch ? { tools: [{ type: this.o.webSearchToolType ?? "web_search" }] } : {}),
    };
  }

  protected createParser(): TurnParser {
    return { parse: (ev) => this.parseEvent(ev) };
  }

  private parseEvent(ev: any): ParsedEvent {
    if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") return { delta: ev.delta };
    if (ev.type === "response.completed" && ev.response?.usage) {
      return { usage: { inputTokens: ev.response.usage.input_tokens ?? 0, outputTokens: ev.response.usage.output_tokens ?? 0 } };
    }
    if (ev.type === "response.failed" || ev.type === "error") {
      const msg = String(ev.response?.error?.message ?? ev.message ?? "OpenAI API stream error");
      const quota = /quota/i.test(msg);
      return { error: new AgentError(quota ? "usage_limit" : "unavailable", msg, { retryable: !quota }) };
    }
    return {};
  }

  protected connectError() { return new AgentError("unavailable", "OpenAI API に接続できません"); }

  protected async httpError(res: Response): Promise<AgentError> {
    let code: string | undefined;
    let message = `OpenAI API error ${res.status}`;
    try {
      const j: any = await res.json();
      code = j?.error?.code ?? j?.error?.type;
      if (j?.error?.message) message = String(j.error.message);
    } catch { /* 本文なし */ }
    if (code === "insufficient_quota") return new AgentError("usage_limit", "OpenAI API の利用枠が不足しています", { retryable: false });
    if (res.status === 401 || res.status === 403) return new AgentError("unavailable", "OpenAI API の認証に失敗しました", { retryable: false });
    if (res.status === 429 || res.status >= 500) return new AgentError("unavailable", message, { retryable: true });
    return new AgentError("protocol", message);
  }
}
