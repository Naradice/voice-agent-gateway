import type { AgentCapability } from "../../../shared/src/types.ts";
import {
  AgentError,
  type AgentAdapter,
  type AgentEvent,
  type AgentSession,
  type HistoryItem,
  type HistoryItemKind,
} from "../adapter.ts";
import { CodexClient, type ServerMessage } from "./client.ts";
import { mapCodexError } from "./errors.ts";

export interface CodexAdapterOptions {
  /** 既定: ["codex", "app-server"]。テストでは偽サーバーを指定する */
  command?: string[];
  /** 1ターンの最大待機。超えたらプロセスを終了して書き込み権を手放す */
  turnTimeoutMs?: number;
  /** turn/start に追加で渡すパラメータ(承認ポリシー等)。既定では何も上書きしない */
  turnParams?: Record<string, unknown>;
}

interface Lease {
  client: CodexClient;
  lastError?: AgentError;
  timer?: NodeJS.Timeout;
  finished: boolean;
}

const KIND: Record<string, HistoryItemKind> = {
  userMessage: "user",
  agentMessage: "agent",
  commandExecution: "command",
  fileChange: "file_change",
  webSearch: "web_search",
  reasoning: "reasoning",
};

const textOf = (item: any): string | undefined => {
  if (typeof item?.text === "string") return item.text;
  if (Array.isArray(item?.content)) return item.content.map((c: any) => c?.text ?? "").join("");
  return undefined;
};

// 時刻の単位は未確認のため、秒/ミリ秒を桁で判定する。
const toIso = (n: unknown): string | undefined =>
  typeof n === "number" ? new Date(n < 1e12 ? n * 1000 : n).toISOString() : undefined;

/**
 * Codex Desktop のスレッドを扱う Adapter。
 * - 読み取りは書き込み権を必要としないので、呼び出しごとに短命の app-server を使う。
 * - 送信は「書き込み権の貸し出し」: 起動 → resume → turn/start → turn/completed まで中継 → 終了(解放)。
 *   Desktop が当該スレッドを開いている間は resume が拒否され、busy になる。
 */
export class CodexAdapter implements AgentAdapter {
  readonly agentType = "codex";
  // interrupt は API 名が未検証のため含めない。
  readonly capabilities: ReadonlySet<AgentCapability> = new Set<AgentCapability>(["list_sessions", "read_history", "send_message", "subscribe"]);

  private opts: CodexAdapterOptions;
  private subs = new Map<string, Set<(e: AgentEvent) => void>>();
  private leases = new Map<string, Lease>();

  constructor(opts: CodexAdapterOptions = {}) {
    this.opts = opts;
  }

  get activeLeaseCount(): number {
    return this.leases.size;
  }

  private async withClient<T>(fn: (c: CodexClient) => Promise<T>): Promise<T> {
    const client = new CodexClient(this.opts.command);
    try {
      await client.request("initialize", { clientInfo: { name: "voice-agent-gateway", version: "0.0.1" } });
      return await fn(client);
    } catch (e) {
      throw mapCodexError(e);
    } finally {
      client.close();
    }
  }

  private toSession(t: any): AgentSession {
    return {
      id: t.id,
      agentId: this.agentType,
      title: t.name ?? String(t.preview ?? "").slice(0, 40),
      preview: t.preview,
      updatedAt: toIso(t.updatedAt),
    };
  }

  listSessions(): Promise<AgentSession[]> {
    return this.withClient(async (c) => {
      const out: AgentSession[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 50; i++) {
        const r: any = await c.request("thread/list", cursor ? { cursor } : {});
        out.push(...(r?.data ?? []).map((t: any) => this.toSession(t)));
        cursor = r?.nextCursor ?? null;
        if (!cursor) break;
      }
      return out;
    });
  }

  getSession(sessionId: string): Promise<AgentSession> {
    return this.withClient(async (c) => this.toSession((await c.request("thread/read", { threadId: sessionId }))?.thread));
  }

  /** includeTurns は非推奨(paginated スレッド)。turns/list → items/list をページングして読む。 */
  readHistory(sessionId: string): Promise<HistoryItem[]> {
    return this.withClient(async (c) => {
      const page = async (method: string, params: Record<string, unknown>) => {
        const rows: any[] = [];
        let cursor: string | null = null;
        for (let i = 0; i < 200; i++) {
          const r: any = await c.request(method, { ...params, ...(cursor ? { cursor } : {}) });
          rows.push(...(r?.data ?? []));
          cursor = r?.nextCursor ?? null;
          if (!cursor) break;
        }
        return rows;
      };
      const out: HistoryItem[] = [];
      for (const turn of await page("thread/turns/list", { threadId: sessionId })) {
        for (const row of await page("thread/items/list", { threadId: sessionId, turnId: turn.id })) {
          const item = row.item ?? {};
          const kind = KIND[item.type] ?? "other";
          out.push({ id: item.id, turnId: row.turnId ?? turn.id, kind, text: kind === "user" || kind === "agent" ? textOf(item) : undefined });
        }
      }
      return out;
    });
  }

  subscribe(sessionId: string, callback: (event: AgentEvent) => void): () => void {
    const set = this.subs.get(sessionId) ?? new Set();
    set.add(callback);
    this.subs.set(sessionId, set);
    return () => { set.delete(callback); };
  }

  private emit(e: AgentEvent): void {
    for (const cb of this.subs.get(e.sessionId) ?? []) {
      try { cb(e); } catch { /* 購読側の例外で貸し出し処理を止めない */ }
    }
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    if (this.leases.has(sessionId)) throw new AgentError("busy", "このスレッドは Gateway が実行中です");

    const client = new CodexClient(this.opts.command);
    const lease: Lease = { client, finished: false };
    this.leases.set(sessionId, lease);

    // 終了を一箇所に集約する。先に解放してから通知するので、受信側はすぐ再送できる。
    const finish = (status: "ok" | "error", error?: AgentError) => {
      if (lease.finished) return;
      lease.finished = true;
      clearTimeout(lease.timer);
      this.leases.delete(sessionId);
      client.close();
      this.emit({ type: "turn.completed", sessionId, status, error });
    };

    try {
      await client.request("initialize", { clientInfo: { name: "voice-agent-gateway", version: "0.0.1" } });
      await client.request("thread/resume", { threadId: sessionId });
    } catch (e) {
      lease.finished = true;
      this.leases.delete(sessionId);
      client.close();
      throw mapCodexError(e);
    }

    // turn/start より前に購読して、最初の通知を取りこぼさない。
    client.onMessage((m) => this.onServerMessage(sessionId, lease, m, finish));
    void client.closed.then(() => finish("error", lease.lastError ?? new AgentError("unavailable", "Codex app-server が終了しました")));
    lease.timer = setTimeout(
      () => finish("error", new AgentError("unavailable", "Codex のターンがタイムアウトしました")),
      this.opts.turnTimeoutMs ?? 30 * 60_000,
    );

    try {
      await client.request("turn/start", { threadId: sessionId, input: [{ type: "text", text }], ...this.opts.turnParams });
    } catch (e) {
      lease.finished = true;
      clearTimeout(lease.timer);
      this.leases.delete(sessionId);
      client.close();
      throw mapCodexError(e);
    }
  }

  // 通知の params の形(delta のフィールド名など)は一部未検証。取れないときは空文字に倒す。
  private onServerMessage(sessionId: string, lease: Lease, m: ServerMessage, finish: (s: "ok" | "error", e?: AgentError) => void) {
    if (m.id !== undefined) {
      // 承認要求など、応答が必要なサーバー発リクエスト。形式が未検証なので承認せず、エラーで拒否する(fail-closed)。
      lease.client.reply(m.id, { error: { code: -32601, message: "voice-agent-gateway: request not supported" } });
      this.emit({ type: "request.unhandled", sessionId, method: m.method });
      return;
    }
    switch (m.method) {
      case "turn/started":
        this.emit({ type: "turn.started", sessionId });
        break;
      case "item/agentMessage/delta":
        this.emit({ type: "message.delta", sessionId, text: String(m.params?.delta ?? m.params?.text ?? "") });
        break;
      case "item/completed":
        if (m.params?.item?.type === "agentMessage") this.emit({ type: "message.completed", sessionId, text: textOf(m.params.item) ?? "" });
        break;
      case "error": {
        // turn/completed は失敗でも届く。error 通知を覚えておき、終了時の status に反映する。
        lease.lastError = mapCodexError(new Error(String(m.params?.message ?? m.params?.error?.message ?? JSON.stringify(m.params ?? {}))));
        this.emit({ type: "error", sessionId, error: lease.lastError });
        break;
      }
      case "turn/completed":
        finish(lease.lastError ? "error" : "ok", lease.lastError);
        break;
    }
  }

  async interrupt(_sessionId: string): Promise<void> {
    throw new AgentError("unsupported", "Codex の割り込み API は未検証のため無効です", { retryable: false });
  }
}
