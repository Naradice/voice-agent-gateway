import type { SessionIndex } from "../../shared/src/types.ts";
import type { AgentSession } from "./adapter.ts";
import type { AdapterRegistry } from "./registry.ts";

/**
 * セッション名から検索用キーワードを作る暫定実装。文字種の連なり(英数字・カタカナ・漢字2字以上)を取り出す。
 * 本来は session_summaries(LLMによる要約・キーワード)で置き換える。汎用語が混ざるため、精度は限定的。
 */
export function deriveKeywords(title: string, preview?: string): string[] {
  const text = `${title} ${(preview ?? "").slice(0, 80)}`;
  const tokens = text.match(/[A-Za-z][A-Za-z0-9]+|[ァ-ヶー]{2,}|[一-龠々]{2,}/g) ?? [];
  return [...new Set(tokens)].slice(0, 20);
}

type Log = (level: "info" | "warn" | "error", msg: string, meta?: object) => void;

/** 全 Adapter のセッションを SessionIndex としてまとめ、一定時間キャッシュする(Codex の一覧取得はプロセス起動を伴うため)。 */
export class SessionCatalog {
  private cache: SessionIndex[] = [];
  private fetchedAt = 0;
  private loading?: Promise<SessionIndex[]>;
  private registry: AdapterRegistry;
  private ttlMs: number;
  private log: Log;

  constructor(registry: AdapterRegistry, ttlMs = 30_000, log: Log = () => {}) {
    this.registry = registry;
    this.ttlMs = ttlMs;
    this.log = log;
  }

  invalidate(): void {
    this.fetchedAt = 0;
  }

  find(sessionId: string): SessionIndex | undefined {
    return this.cache.find((s) => s.id === sessionId);
  }

  async list(): Promise<SessionIndex[]> {
    if (Date.now() - this.fetchedAt < this.ttlMs) return this.cache;
    this.loading ??= this.load().finally(() => { this.loading = undefined; });
    return this.loading;
  }

  private async load(): Promise<SessionIndex[]> {
    const out: SessionIndex[] = [];
    let failures = 0;
    for (const adapter of this.registry.list()) {
      try {
        const sessions: AgentSession[] = await adapter.listSessions();
        for (const s of sessions) {
          out.push({
            id: s.id,
            agentId: adapter.agentType,
            externalSessionId: s.id,
            title: s.title,
            summary: s.preview ?? s.title,
            keywords: deriveKeywords(s.title, s.preview),
            lastActiveAt: s.updatedAt ?? new Date(0).toISOString(),
            capabilities: [...adapter.capabilities],
          });
        }
      } catch (e) {
        // 1つの Agent の失敗(例: Codex が起動できない)で他の Agent を使えなくしない。
        failures++;
        this.log("warn", "session listing failed", { agent: adapter.agentType, error: String(e) });
        out.push(...this.cache.filter((c) => c.agentId === adapter.agentType)); // 失敗した Agent は前回の一覧を維持
      }
    }
    this.cache = out;
    // 失敗があった場合は短い間隔で再試行できるよう、キャッシュ時刻を進めすぎない
    this.fetchedAt = failures ? Date.now() - this.ttlMs + 5_000 : Date.now();
    return out;
  }
}
