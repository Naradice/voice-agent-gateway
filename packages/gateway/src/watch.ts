import type { AgentAdapter } from "./adapter.ts";

type Log = (level: "info" | "warn" | "error", msg: string, meta?: object) => void;

export interface CompletionWatcherOptions {
  adapter: Pick<AgentAdapter, "listSessions">;
  /** 作業が一区切りしたスレッドを通知する */
  onSettled: (s: { id: string; title: string }) => void;
  intervalMs?: number;
  log?: Log;
}

interface State { seen?: string; pending: boolean; own: boolean }

/**
 * 定期的にセッション一覧を読み、更新が止まったスレッドを「作業が終わった」として通知する。
 * 判定は「更新時刻が変わった後、次の確認でも変わっていない」。ターンの状態(completed)は見ていない
 * (thread/turns/list の項目名が未検証のため)。実行中に長く更新が止まると、早めに通知する可能性がある。
 * - 初回の確認は基準を覚えるだけで通知しない。
 * - この Gateway が送った指示による更新は通知しない(noteOwn)。
 */
export class CompletionWatcher {
  private states = new Map<string, State>();
  private timer?: NodeJS.Timeout;
  private running = false;
  private primed = false;
  private lastWarn = 0;

  private o: CompletionWatcherOptions;
  constructor(o: CompletionWatcherOptions) { this.o = o; }

  start(): void {
    if (this.timer) return;
    const tick = () => void this.poll();
    this.timer = setInterval(tick, this.o.intervalMs ?? 60_000);
    this.timer.unref?.();
    tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  noteOwn(sessionId: string): void {
    const s = this.states.get(sessionId) ?? { pending: false, own: false };
    s.own = true;
    s.pending = true; // 更新が止まるまで待ち、止まったら通知せずに基準へ戻す
    this.states.set(sessionId, s);
  }

  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const sessions = await this.o.adapter.listSessions();
      for (const s of sessions) {
        const st = this.states.get(s.id) ?? { pending: false, own: false };
        this.states.set(s.id, st);
        if (st.seen !== s.updatedAt) {
          const first = st.seen === undefined && !this.primed;
          st.seen = s.updatedAt;
          if (!first) st.pending = true; // 動いている。止まるまで待つ
        } else if (st.pending) {
          st.pending = false;
          const own = st.own;
          st.own = false;
          if (!own) this.o.onSettled({ id: s.id, title: s.title });
        }
      }
      this.primed = true;
    } catch (e) {
      // 一時的な失敗(Codex が起動できない等)。ログは 10 分に 1 回まで。
      if (Date.now() - this.lastWarn > 600_000) {
        this.lastWarn = Date.now();
        this.o.log?.("warn", "codex polling failed", { error: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      this.running = false;
    }
  }
}
