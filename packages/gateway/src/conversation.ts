import type { AgentCapability } from "../../shared/src/types.ts";
import { AgentError, type AgentAdapter, type AgentEvent, type AgentSession, type HistoryItem } from "./adapter.ts";
import type { SessionRow, Store } from "./store.ts";
import { sseEvents } from "./openai/sse.ts";

export interface ConversationOptions {
  store: Store;
  model: string;
  /** API へ渡す直近メッセージ数の上限(§9.3: 送る履歴は必要最小限) */
  maxHistoryMessages?: number;
  /** 履歴の文字数の上限。超えたら古いものから落とす(最新の発話は常に残す) */
  maxHistoryChars?: number;
  fetch?: typeof fetch;
  /** サーバー側に設定されているモデルの文脈長(トークン)。入力がこれに迫ったら warning を出す。未指定なら検知しない */
  contextTokens?: number;
  /** Gateway 上の論理的な宛先名(ルーターの destination と一致させる)。バックエンドを替えても変わらない */
  agentType?: string;
  /**
   * 発話から、このターンだけモデルに渡す補足文脈(検索結果など)を作る。undefined なら何も足さない。
   * 補足文脈は履歴に保存しない。失敗しても会話は止めない(例外は無視して文脈なしで続行)。
   */
  grounding?: (text: string) => Promise<string | undefined>;
}

export interface ChatMessage { role: "user" | "assistant"; content: string }

/** ストリームの1イベントから取り出した内容。プロトコル固有の解釈は派生クラスが行う。 */
export interface ParsedEvent {
  delta?: string;
  usage?: { inputTokens: number; outputTokens: number };
  error?: AgentError;
}

/** 1ターンのストリームを読む状態。思考タグの除去などターンをまたぐ状態はここに持つ。 */
export interface TurnParser {
  parse(ev: any): ParsedEvent;
  /** ストリーム終了時に溜まっている末尾を返す */
  flush?(): string;
}

interface InFlight { abort: AbortController; partial: string; interrupted: boolean }

/**
 * Gateway が会話履歴(SQLite)を正本として持ち、毎回履歴を送ってストリーミング応答を受ける Adapter の共通部分。
 * 通信方式(エンドポイント・本文・イベント形式・HTTPエラーの解釈)だけを派生クラスが定める。
 */
export abstract class ConversationAdapter implements AgentAdapter {
  abstract readonly agentType: string;
  readonly capabilities: ReadonlySet<AgentCapability> = new Set<AgentCapability>(["list_sessions", "read_history", "send_message", "subscribe", "interrupt", "create_session"]);

  protected c: ConversationOptions;
  private subs = new Map<string, Set<(e: AgentEvent) => void>>();
  private inflight = new Map<string, InFlight>();

  constructor(opts: ConversationOptions) {
    this.c = opts;
  }

  protected abstract endpoint(): string;
  protected abstract headers(): Record<string, string>;
  protected abstract body(history: ChatMessage[], context?: string): unknown;
  protected abstract createParser(): TurnParser;
  protected abstract httpError(res: Response): Promise<AgentError>;
  protected abstract connectError(): AgentError;

  private toSession(r: SessionRow): AgentSession {
    return { id: r.id, agentId: this.agentType, title: r.title, updatedAt: r.lastActiveAt };
  }

  async listSessions(): Promise<AgentSession[]> {
    return this.c.store.listSessions(this.agentType).map((r) => this.toSession(r));
  }

  async getSession(sessionId: string): Promise<AgentSession> {
    const r = this.c.store.getSession(sessionId);
    if (!r || r.agentId !== this.agentType) throw new AgentError("not_found", "セッションが見つかりません");
    return this.toSession(r);
  }

  async createSession(title = "新しい会話"): Promise<AgentSession> {
    return this.toSession(this.c.store.createSession({ agentId: this.agentType, title }));
  }

  async readHistory(sessionId: string): Promise<HistoryItem[]> {
    await this.getSession(sessionId);
    return this.c.store.messages(sessionId).map((m) => ({ id: m.id, turnId: m.id, kind: m.role === "user" ? "user" : "agent", text: m.text }));
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

  private history(sessionId: string): ChatMessage[] {
    let h = this.c.store.messages(sessionId).slice(-(this.c.maxHistoryMessages ?? 40)).map((m) => ({ role: m.role, content: m.text }));
    const budget = this.c.maxHistoryChars;
    if (budget !== undefined) {
      while (h.length > 1 && h.reduce((n, m) => n + m.content.length, 0) > budget) h = h.slice(1);
    }
    return h;
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    await this.getSession(sessionId);
    if (this.inflight.has(sessionId)) throw new AgentError("busy", "このセッションは応答中です");

    const { store } = this.c;
    const first = store.messages(sessionId).length === 0;
    const userMsg = store.addMessage(sessionId, "user", text);
    const history = this.history(sessionId);

    const state: InFlight = { abort: new AbortController(), partial: "", interrupted: false };
    this.inflight.set(sessionId, state);
    const rollback = () => { this.inflight.delete(sessionId); store.deleteMessage(userMsg.id); };

    let context: string | undefined;
    if (this.c.grounding) {
      try { context = await this.c.grounding(text); } catch { /* 文脈なしで続行 */ }
    }

    let res: Response;
    try {
      res = await (this.c.fetch ?? fetch)(this.endpoint(), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(this.body(history, context)),
        signal: state.abort.signal,
      });
    } catch (e) {
      rollback();
      const err = state.interrupted ? new AgentError("unavailable", "開始前に中断されました") : this.connectError();
      throw new AgentError(err.kind, err.message, { retryable: err.retryable, cause: e });
    }
    if (!res.ok || !res.body) {
      const err = await this.httpError(res);
      rollback();
      throw err;
    }

    if (first) store.setTitle(sessionId, text.slice(0, 20));
    void this.consume(sessionId, state, res.body);
  }

  private async consume(sessionId: string, state: InFlight, body: ReadableStream<Uint8Array>): Promise<void> {
    const { store } = this.c;
    let error: AgentError | undefined;
    this.emit({ type: "turn.started", sessionId });
    const parser = this.createParser();
    try {
      for await (const ev of sseEvents(body)) {
        const p = parser.parse(ev);
        if (p.delta) {
          state.partial += p.delta;
          this.emit({ type: "message.delta", sessionId, text: p.delta });
        }
        if (p.usage) {
          store.recordUsage({ sessionId, model: this.c.model, inputTokens: p.usage.inputTokens, outputTokens: p.usage.outputTokens });
          const cap = this.c.contextTokens;
          if (cap && p.usage.inputTokens >= cap * 0.9) {
            this.emit({ type: "warning", sessionId, code: "context_nearly_full", message: `入力 ${p.usage.inputTokens} トークンが文脈長 ${cap} に迫っています。古い履歴が切られている可能性があります` });
          }
        }
        if (p.error) error = p.error;
      }
    } catch (e) {
      if (!state.interrupted) error = new AgentError("unavailable", "応答が途中で切れました", { cause: e });
    }

    const tail = parser.flush?.();
    if (tail) {
      state.partial += tail;
      this.emit({ type: "message.delta", sessionId, text: tail });
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
