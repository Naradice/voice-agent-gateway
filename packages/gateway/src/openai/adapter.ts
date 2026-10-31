import type { AgentCapability } from "../../../shared/src/types.ts";
import { AgentError, type AgentAdapter, type AgentEvent, type AgentSession, type HistoryItem } from "../adapter.ts";
import type { Store, SessionRow } from "../store.ts";
import { sseEvents } from "./sse.ts";

export interface OpenAIAdapterOptions {
  store: Store;
  apiKey: string;
  /** 使用するモデルID。既定値は置かない(利用者が決める) */
  model: string;
  baseUrl?: string;
  /** 読み上げ向けの指示(簡潔に、コードや長いURLを読み上げない等) */
  instructions?: string;
  /** 最新情報が必要な質問用(§5.6)。ツール種別名は未検証のため、有効化時は webSearchToolType で指定可 */
  webSearch?: boolean;
  webSearchToolType?: string;
  /** API へ渡す直近メッセージ数の上限(§9.3: 送る履歴は必要最小限) */
  maxHistoryMessages?: number;
  fetch?: typeof fetch;
}

interface InFlight { abort: AbortController; partial: string; interrupted: boolean }

/**
 * OpenAI API を使う Adapter。会話履歴は Gateway(SQLite)が正本で、API には毎回履歴を送る(store:false)。
 * ChatGPT 公式アプリの会話とは同期しない(§6.2)。
 * Responses API のイベント名(response.output_text.delta / response.completed)は公式ドキュメントに基づく。
 * 実キーでの実機確認はまだ。
 */
export class OpenAIAdapter implements AgentAdapter {
  readonly agentType = "openai";
  readonly capabilities: ReadonlySet<AgentCapability> = new Set<AgentCapability>(["list_sessions", "read_history", "send_message", "subscribe", "interrupt", "create_session"]);

  private o: OpenAIAdapterOptions;
  private subs = new Map<string, Set<(e: AgentEvent) => void>>();
  private inflight = new Map<string, InFlight>();

  constructor(opts: OpenAIAdapterOptions) {
    this.o = opts;
  }

  private toSession(r: SessionRow): AgentSession {
    return { id: r.id, agentId: this.agentType, title: r.title, updatedAt: r.lastActiveAt };
  }

  async listSessions(): Promise<AgentSession[]> {
    return this.o.store.listSessions(this.agentType).map((r) => this.toSession(r));
  }

  async getSession(sessionId: string): Promise<AgentSession> {
    const r = this.o.store.getSession(sessionId);
    if (!r || r.agentId !== this.agentType) throw new AgentError("not_found", "セッションが見つかりません");
    return this.toSession(r);
  }

  async createSession(title = "新しい会話"): Promise<AgentSession> {
    return this.toSession(this.o.store.createSession({ agentId: this.agentType, title }));
  }

  async readHistory(sessionId: string): Promise<HistoryItem[]> {
    await this.getSession(sessionId);
    return this.o.store.messages(sessionId).map((m) => ({ id: m.id, turnId: m.id, kind: m.role === "user" ? "user" : "agent", text: m.text }));
  }

  subscribe(sessionId: string, callback: (event: AgentEvent) => void): () => void {
    const set = this.subs.get(sessionId) ?? new Set();
    set.add(callback);
    this.subs.set(sessionId, set);
    return () => { set.delete(callback); };
  }

  private emit(e: AgentEvent): void {
    for (const cb of this.subs.get(e.sessionId) ?? []) {
      try { cb(e); } catch { /* 購読側の例外で処理を止めない */ }
    }
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    await this.getSession(sessionId);
    if (this.inflight.has(sessionId)) throw new AgentError("busy", "このセッションは応答中です");

    const { store } = this.o;
    const first = store.messages(sessionId).length === 0;
    const userMsg = store.addMessage(sessionId, "user", text);
    const history = store.messages(sessionId).slice(-(this.o.maxHistoryMessages ?? 40)).map((m) => ({ role: m.role, content: m.text }));

    const state: InFlight = { abort: new AbortController(), partial: "", interrupted: false };
    this.inflight.set(sessionId, state);
    const rollback = () => { this.inflight.delete(sessionId); store.deleteMessage(userMsg.id); };

    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(`${this.o.baseUrl ?? "https://api.openai.com/v1"}/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.o.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.o.model,
          input: history,
          stream: true,
          store: false, // 会話の正本は Gateway。OpenAI 側には保存させない
          ...(this.o.instructions ? { instructions: this.o.instructions } : {}),
          ...(this.o.webSearch ? { tools: [{ type: this.o.webSearchToolType ?? "web_search" }] } : {}),
        }),
        signal: state.abort.signal,
      });
    } catch (e) {
      rollback();
      throw new AgentError("unavailable", state.interrupted ? "開始前に中断されました" : "OpenAI API に接続できません", { cause: e });
    }
    if (!res.ok || !res.body) {
      const err = await this.httpError(res);
      rollback();
      throw err;
    }

    if (first) store.setTitle(sessionId, text.slice(0, 20));
    void this.consume(sessionId, state, res.body);
  }

  private async httpError(res: Response): Promise<AgentError> {
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

  private async consume(sessionId: string, state: InFlight, body: ReadableStream<Uint8Array>): Promise<void> {
    const { store } = this.o;
    let error: AgentError | undefined;
    this.emit({ type: "turn.started", sessionId });
    try {
      for await (const ev of sseEvents(body)) {
        if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") {
          state.partial += ev.delta;
          this.emit({ type: "message.delta", sessionId, text: ev.delta });
        } else if (ev.type === "response.completed") {
          const u = ev.response?.usage;
          if (u) store.recordUsage({ sessionId, model: this.o.model, inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 });
        } else if (ev.type === "response.failed" || ev.type === "error") {
          const msg = String(ev.response?.error?.message ?? ev.message ?? "OpenAI API stream error");
          error = new AgentError(/quota/i.test(msg) ? "usage_limit" : "unavailable", msg, { retryable: !/quota/i.test(msg) });
        }
      }
    } catch (e) {
      if (!state.interrupted) error = new AgentError("unavailable", "OpenAI API の応答が途中で切れました", { cause: e });
    }

    // 解放してから通知する(受信側がすぐ次の指示を送れるように)。
    this.inflight.delete(sessionId);
    if (state.partial) store.addMessage(sessionId, "assistant", state.partial);
    if (state.partial && !error) this.emit({ type: "message.completed", sessionId, text: state.partial, phase: "final_answer" });
    if (error) this.emit({ type: "error", sessionId, error });
    this.emit({ type: "turn.completed", sessionId, status: state.interrupted ? "interrupted" : error ? "error" : "ok", error: state.interrupted ? undefined : error });
  }

  async interrupt(sessionId: string): Promise<void> {
    const s = this.inflight.get(sessionId);
    if (!s) return;
    s.interrupted = true;
    s.abort.abort();
  }
}
