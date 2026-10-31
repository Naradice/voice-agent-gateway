// 設計書 §6.1 の AgentAdapter。Agent固有の型・仕様はここに持ち込まない。
// ここでの sessionId は「外部Agent側のID」(Codex なら thread ID)。Gateway内部IDとの対応は Session Manager が持つ。
import type { AgentCapability } from "../../shared/src/types.ts";

export type AgentErrorKind =
  | "busy" // 他のプロセス(例: Codex Desktop)が書き込み権を持つ。再試行は利用者の判断
  | "usage_limit" // Agent側の利用上限。解除まで再試行しても無駄
  | "not_found"
  | "unsupported" // この Adapter/Agent が未対応、または未検証のため無効
  | "unavailable" // 起動失敗・接続断・タイムアウト
  | "protocol"; // 想定外の応答

export class AgentError extends Error {
  readonly kind: AgentErrorKind;
  readonly retryable: boolean;
  constructor(kind: AgentErrorKind, message: string, opts: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = "AgentError";
    this.kind = kind;
    this.retryable = opts.retryable ?? (kind === "busy" || kind === "unavailable");
  }
}

export interface AgentSession {
  id: string;
  agentId: string;
  title: string;
  /** 一覧用の先頭テキスト。要約・キーワード生成の入力に使う */
  preview?: string;
  updatedAt?: string;
}

export type HistoryItemKind = "user" | "agent" | "command" | "file_change" | "web_search" | "reasoning" | "other";

export interface HistoryItem {
  id: string;
  turnId: string;
  kind: HistoryItemKind;
  /** 本文。kind が user/agent のときのみ。API が返した順序を保つ(時刻で並べ直さない) */
  text?: string;
}

export type AgentEvent =
  | { type: "turn.started"; sessionId: string }
  | { type: "message.delta"; sessionId: string; text: string }
  /** phase は Agent が付ける区別(Codex: "final_answer" / 途中経過など)。読み上げは final_answer を優先する */
  | { type: "message.completed"; sessionId: string; text: string; phase?: string }
  /** Agentが承認等の応答を求めたが、Approval Manager 未実装のため拒否した(§9.2: 音声だけで承認させない) */
  | { type: "request.unhandled"; sessionId: string; method: string }
  | { type: "error"; sessionId: string; error: AgentError }
  /** 会話は続くが注意が必要なこと。例: context_nearly_full(入力がモデルの文脈長に迫り、古い履歴が黙って切られる恐れ) */
  | { type: "warning"; sessionId: string; code: "context_nearly_full"; message: string }
  /** 成功とは限らない。status と error を必ず見ること */
  | { type: "turn.completed"; sessionId: string; status: "ok" | "error" | "interrupted"; error?: AgentError };

export interface AgentAdapter {
  readonly agentType: string;
  /** 非対応操作は明示する(§6.1)。未検証の機能は含めない */
  readonly capabilities: ReadonlySet<AgentCapability>;

  listSessions(): Promise<AgentSession[]>;
  getSession(sessionId: string): Promise<AgentSession>;
  /** 読み取り専用。書き込み権を必要としない */
  readHistory(sessionId: string): Promise<HistoryItem[]>;
  /** 応答が近いことを知らせる(例: PTT が押された)。モデルの先読みなど、あれば遅延を減らす準備を行う。失敗しても例外にしない */
  prepare?(): Promise<void>;
  /** 新規セッションを作る。capabilities に create_session があるときのみ */
  createSession?(title?: string): Promise<AgentSession>;
  /** 指示が受理された時点で解決する。結果は subscribe のイベントで届く */
  sendMessage(sessionId: string, text: string): Promise<void>;
  subscribe(sessionId: string, callback: (event: AgentEvent) => void): () => void;
  interrupt(sessionId: string): Promise<void>;
}
