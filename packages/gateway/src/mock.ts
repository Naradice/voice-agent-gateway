// Android クライアントの開発・結合テスト用のモック Gateway。Ollama も Codex も不要。
// 本物の Gateway(ルーター・重複排除・再送・読み上げ整形)をそのまま使い、Agent だけを台本どおりに動く偽物にしている。
//   npm run gateway:mock        (.env があれば VAG_DEVICES / VAG_HOST / VAG_PORT を読む)
//
// 発話で次の挙動を確認できる:
//   「こんにちは」           新しい会話が作られ、3文が文単位で読み上げられる
//   「JEPAの実験の件」        チャットとCodexの両方に該当 → 確認要求(1番=Codex、2番=チャット)
//   「busyの確認をCodexで」   Codex が使用中(busy)で拒否される
//   「loadingを試して」        モデル起動中の通知 → 少し待って回答
//   「止めて」                応答の途中なら中断される
import { RuleRouter } from "../../phase0b-router-eval/src/rule-router.ts";
import type { AgentCapability } from "../../shared/src/types.ts";
import { AgentError, type AgentAdapter, type AgentEvent, type AgentSession, type HistoryItem } from "./adapter.ts";
import { checkHost, jsonLog, parseDevices } from "./config.ts";
import { loadDotEnv } from "./env.ts";
import { Gateway } from "./gateway.ts";
import { AdapterRegistry } from "./registry.ts";
import { startServer } from "./server.ts";
import { Store } from "./store.ts";

type Listener = (e: AgentEvent) => void;

abstract class MockAdapter implements AgentAdapter {
  abstract readonly agentType: string;
  abstract readonly capabilities: ReadonlySet<AgentCapability>;
  protected sessions: AgentSession[] = [];
  protected history = new Map<string, HistoryItem[]>();
  private subs = new Map<string, Set<Listener>>();

  async listSessions() { return this.sessions; }
  async getSession(id: string) {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) throw new AgentError("not_found", "セッションが見つかりません");
    return s;
  }
  async readHistory(id: string) { return this.history.get(id) ?? []; }
  subscribe(id: string, cb: Listener) {
    const set = this.subs.get(id) ?? new Set<Listener>();
    set.add(cb);
    this.subs.set(id, set);
    return () => { set.delete(cb); };
  }
  protected emit(e: AgentEvent) { for (const cb of this.subs.get(e.sessionId) ?? []) cb(e); }
  abstract sendMessage(sessionId: string, text: string): Promise<void>;
  async interrupt(_id: string): Promise<void> { throw new AgentError("unsupported", "未対応"); }
  protected remember(id: string, kind: "user" | "agent", text: string) {
    const h = this.history.get(id) ?? [];
    h.push({ id: `${id}-${h.length}`, turnId: `${id}-t`, kind, text });
    this.history.set(id, h);
  }
}

/** チャット: 台本の応答を 5 文字ずつ 25ms 間隔でストリーミングする。 */
class MockChat extends MockAdapter {
  readonly agentType = "chat";
  readonly capabilities = new Set<AgentCapability>(["list_sessions", "read_history", "send_message", "subscribe", "interrupt", "create_session"]);
  private running = new Map<string, { timer?: NodeJS.Timeout; stop: () => void }>();

  constructor() {
    super();
    const at = new Date().toISOString();
    this.sessions = [
      { id: "c-jepa", agentId: "chat", title: "JEPA研究相談", updatedAt: at },
      { id: "c-daily", agentId: "chat", title: "雑談", updatedAt: at },
    ];
  }

  async createSession(title = "新しい会話") {
    const s = { id: `c-${this.sessions.length + 1}`, agentId: "chat", title, updatedAt: new Date().toISOString() };
    this.sessions.push(s);
    return s;
  }

  async sendMessage(id: string, text: string) {
    await this.getSession(id);
    if (this.running.has(id)) throw new AgentError("busy", "応答中です");
    this.remember(id, "user", text);
    const reply = `「${text.slice(0, 20)}」ですね。これはモックの応答です。実際のモデルは動いていません。`;
    const wait = /loading/i.test(text) ? 600 : 0;
    if (wait) this.emit({ type: "status", sessionId: id, code: "model_loading", message: "モデルを起動しています。少しお待ちください" });
    this.emit({ type: "turn.started", sessionId: id });
    let pos = 0;
    const run: { timer?: NodeJS.Timeout; stop: () => void } = { stop: () => {} };
    this.running.set(id, run);
    const tick = () => {
      if (pos < reply.length) {
        this.emit({ type: "message.delta", sessionId: id, text: reply.slice(pos, pos + 5) });
        pos += 5;
        run.timer = setTimeout(tick, 25);
        return;
      }
      this.running.delete(id);
      this.remember(id, "agent", reply);
      this.emit({ type: "message.completed", sessionId: id, text: reply, phase: "final_answer" });
      this.emit({ type: "turn.completed", sessionId: id, status: "ok" });
    };
    run.stop = () => {
      clearTimeout(run.timer);
      this.running.delete(id);
      this.emit({ type: "turn.completed", sessionId: id, status: "interrupted" });
    };
    run.timer = setTimeout(tick, wait);
  }

  async interrupt(id: string) { this.running.get(id)?.stop(); }
}

/** Codex: 途中経過 → 最終回答。title に busy を含むセッションは、別のアプリが使用中として拒否する。割り込みは未対応。 */
class MockCodex extends MockAdapter {
  readonly agentType = "codex";
  readonly capabilities = new Set<AgentCapability>(["list_sessions", "read_history", "send_message", "subscribe"]);

  constructor() {
    super();
    const at = new Date().toISOString();
    this.sessions = [
      { id: "x-jepa", agentId: "codex", title: "JEPA実験", updatedAt: at },
      { id: "x-busy", agentId: "codex", title: "busy検証", updatedAt: at },
    ];
    this.remember("x-jepa", "agent", "前回の実験は精度0.9で完了しました。");
  }

  async sendMessage(id: string, text: string) {
    const s = await this.getSession(id);
    if (s.title.includes("busy")) throw new AgentError("busy", "別のアプリが使用中");
    this.remember(id, "user", text);
    this.emit({ type: "turn.started", sessionId: id });
    setTimeout(() => this.emit({ type: "message.completed", sessionId: id, text: "ファイルを調べています", phase: "commentary" }), 300);
    setTimeout(() => {
      const answer = "作業が完了しました。実験の精度は0.9でした。";
      this.remember(id, "agent", answer);
      this.emit({ type: "message.completed", sessionId: id, text: answer, phase: "final_answer" });
      this.emit({ type: "turn.completed", sessionId: id, status: "ok" });
    }, 800);
  }
}

loadDotEnv();
const registry = new AdapterRegistry();
registry.register(new MockChat());
registry.register(new MockCodex());
const gateway = new Gateway({
  store: new Store(process.env.VAG_DB ?? ":memory:"),
  registry,
  log: jsonLog,
  router: new RuleRouter({ name: "mock", confirmVague: true, crossAgentConfirm: true }),
});
const server = await startServer({
  gateway,
  devices: parseDevices(process.env.VAG_DEVICES),
  host: checkHost(process.env.VAG_HOST ?? "127.0.0.1"),
  port: Number(process.env.VAG_PORT ?? 8787),
  log: jsonLog,
});
jsonLog("info", "gateway started", { mode: "mock", port: server.port, agents: ["chat", "codex"] });
const shutdown = async () => { await server.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
