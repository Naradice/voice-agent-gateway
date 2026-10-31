// 設計書 §7 の SQLite。外部Agent(Codex)の履歴は正本とみなさない。ここで正本になるのは Gateway が管理する会話(OpenAI)のみ。
// 未実装(後続): agents, session_summaries, routing_decisions, pending_events。
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export interface SessionRow {
  id: string;
  agentId: string;
  externalSessionId?: string;
  title: string;
  createdAt: string;
  lastActiveAt: string;
}

export interface StoredMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export type RequestState = "received" | "dispatching" | "awaiting_confirmation" | "accepted" | "failed" | "cancelled" | "indeterminate";

export interface RequestRecord { state: RequestState; result?: any; createdAt: string }

export interface UsageTotals { inputTokens: number; outputTokens: number; requests: number }

export class Store {
  private db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, external_session_id TEXT, title TEXT NOT NULL,
        created_at TEXT NOT NULL, last_active_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user','assistant')), text TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, seq);
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pending_events_device ON pending_events(device_id, seq);
      CREATE TABLE IF NOT EXISTS requests (
        device_id TEXT NOT NULL, request_id TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY (device_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS device_state (
        device_id TEXT PRIMARY KEY, current_session_id TEXT
      );
      CREATE TABLE IF NOT EXISTS routing_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, request_id TEXT NOT NULL,
        utterance TEXT NOT NULL, decision TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA foreign_keys = ON;
    `);
  }

  createSession(o: { agentId: string; title: string; externalSessionId?: string; id?: string }): SessionRow {
    const now = new Date().toISOString();
    const id = o.id ?? randomUUID();
    this.db.prepare("INSERT INTO sessions (id, agent_id, external_session_id, title, created_at, last_active_at) VALUES (?,?,?,?,?,?)")
      .run(id, o.agentId, o.externalSessionId ?? null, o.title, now, now);
    return { id, agentId: o.agentId, externalSessionId: o.externalSessionId, title: o.title, createdAt: now, lastActiveAt: now };
  }

  private toSession(r: any): SessionRow {
    return { id: r.id, agentId: r.agent_id, externalSessionId: r.external_session_id ?? undefined, title: r.title, createdAt: r.created_at, lastActiveAt: r.last_active_at };
  }

  getSession(id: string): SessionRow | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    return r ? this.toSession(r) : undefined;
  }

  listSessions(agentId?: string): SessionRow[] {
    const rows = agentId
      ? this.db.prepare("SELECT * FROM sessions WHERE agent_id = ? ORDER BY last_active_at DESC").all(agentId)
      : this.db.prepare("SELECT * FROM sessions ORDER BY last_active_at DESC").all();
    return rows.map((r) => this.toSession(r));
  }

  setTitle(id: string, title: string): void {
    this.db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(title, id);
  }

  addMessage(sessionId: string, role: "user" | "assistant", text: string): StoredMessage {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare("INSERT INTO messages (id, session_id, role, text, created_at) VALUES (?,?,?,?,?)").run(id, sessionId, role, text, now);
    this.db.prepare("UPDATE sessions SET last_active_at = ? WHERE id = ?").run(now, sessionId);
    return { id, sessionId, role, text, createdAt: now };
  }

  deleteMessage(id: string): void {
    this.db.prepare("DELETE FROM messages WHERE id = ?").run(id);
  }

  messages(sessionId: string): StoredMessage[] {
    return this.db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY seq").all(sessionId)
      .map((r: any) => ({ id: r.id, sessionId: r.session_id, role: r.role, text: r.text, createdAt: r.created_at }));
  }

  recordUsage(o: { sessionId?: string; model: string; inputTokens: number; outputTokens: number }): void {
    this.db.prepare("INSERT INTO usage (session_id, model, input_tokens, output_tokens, created_at) VALUES (?,?,?,?,?)")
      .run(o.sessionId ?? null, o.model, o.inputTokens, o.outputTokens, new Date().toISOString());
  }

  usageTotals(): UsageTotals {
    const r: any = this.db.prepare("SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COUNT(*) n FROM usage").get();
    return { inputTokens: r.i, outputTokens: r.o, requests: r.n };
  }

  /**
   * この DB の識別子。DB を作り直したり別の Gateway につなぎ替えたりすると変わる。
   * 端末が覚えている ack の位置(イベント番号)は DB ごとに意味が違うので、識別子が違うときは位置を信用しない。
   */
  instanceId(): string {
    const r: any = this.db.prepare("SELECT value FROM meta WHERE key = 'instance_id'").get();
    if (r) return r.value;
    const id = randomUUID();
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('instance_id', ?)").run(id);
    return id;
  }

  // --- 未配信イベント (§8.4): 保存 → 配信 → 端末が ack したら削除 ---

  appendEvent(deviceId: string, payload: object): number {
    const r = this.db.prepare("INSERT INTO pending_events (device_id, payload, created_at) VALUES (?,?,?)")
      .run(deviceId, JSON.stringify(payload), new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  /** seq より後の未 ack イベントを古い順に返す。 */
  eventsAfter(deviceId: string, seq: number): { seq: number; payload: any }[] {
    return this.db.prepare("SELECT seq, payload FROM pending_events WHERE device_id = ? AND seq > ? ORDER BY seq")
      .all(deviceId, seq).map((r: any) => ({ seq: r.seq, payload: JSON.parse(r.payload) }));
  }

  ackThrough(deviceId: string, seq: number): void {
    this.db.prepare("DELETE FROM pending_events WHERE device_id = ? AND seq <= ?").run(deviceId, seq);
  }

  pruneEvents(olderThan: string): void {
    this.db.prepare("DELETE FROM pending_events WHERE created_at < ?").run(olderThan);
  }

  // --- 要求の記録 (§8.4): requestId による重複排除と、結果不明の検出 ---

  getRequest(deviceId: string, requestId: string): RequestRecord | undefined {
    const r: any = this.db.prepare("SELECT * FROM requests WHERE device_id = ? AND request_id = ?").get(deviceId, requestId);
    return r ? { state: r.state, result: r.result ? JSON.parse(r.result) : undefined, createdAt: r.created_at } : undefined;
  }

  putRequest(deviceId: string, requestId: string, state: RequestState, result?: unknown): void {
    this.db.prepare(`INSERT INTO requests (device_id, request_id, state, result, created_at) VALUES (?,?,?,?,?)
      ON CONFLICT(device_id, request_id) DO UPDATE SET state = excluded.state, result = excluded.result`)
      .run(deviceId, requestId, state, result === undefined ? null : JSON.stringify(result), new Date().toISOString());
  }

  /** 起動時に呼ぶ。実行中だった要求は、外部Agentに届いたか分からないので「結果不明」にする。 */
  markInterruptedRequestsIndeterminate(): number {
    const r = this.db.prepare("UPDATE requests SET state = 'indeterminate' WHERE state IN ('received','dispatching')").run();
    return Number(r.changes);
  }

  pruneRequests(olderThan: string): void {
    this.db.prepare("DELETE FROM requests WHERE created_at < ? AND state NOT IN ('received','dispatching','awaiting_confirmation')").run(olderThan);
  }

  getCurrentSession(deviceId: string): string | undefined {
    const r: any = this.db.prepare("SELECT current_session_id FROM device_state WHERE device_id = ?").get(deviceId);
    return r?.current_session_id ?? undefined;
  }

  setCurrentSession(deviceId: string, sessionId: string | undefined): void {
    this.db.prepare("INSERT INTO device_state (device_id, current_session_id) VALUES (?,?) ON CONFLICT(device_id) DO UPDATE SET current_session_id = excluded.current_session_id")
      .run(deviceId, sessionId ?? null);
  }

  /** ルーティング判定の記録。誤配送率の実測(Phase 0B)に使う。発話本文を含むので保存期間に注意。 */
  recordRouting(deviceId: string, requestId: string, utterance: string, decision: unknown): void {
    this.db.prepare("INSERT INTO routing_decisions (device_id, request_id, utterance, decision, created_at) VALUES (?,?,?,?,?)")
      .run(deviceId, requestId, utterance, JSON.stringify(decision), new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }
}
