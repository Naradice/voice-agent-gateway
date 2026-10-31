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

  close(): void {
    this.db.close();
  }
}
