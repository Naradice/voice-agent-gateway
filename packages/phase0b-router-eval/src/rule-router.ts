import type { Router, RouterContext, RoutingDecision, SessionIndex } from "../../shared/src/types.ts";
import { keywordRetriever, type Retriever } from "./retrievers.ts";

const AGENT_PATTERNS: [string, RegExp][] = [
  ["codex", /codex|コーデックス|コデックス|コデクス|コーデクス/i],
  ["chat", /chat ?gpt|チャット ?gpt|チャットジーピーティー|openai/i],
];
const INTERRUPT = /止めて|やめて|ストップ|中断|キャンセル/;
const READ_LATEST = /(返事|返信).*(読んで|聞かせて|教えて)|もう一度読んで/;
const CONTINUE = /(その|この)(話|件)の?続き|続きを|続きで|さっきの|それについて/;
const TOPIC_CHANGE = /別の話|話は変わ|ところで|話題を変え/;
const VAGUE = /^(あれ|あの件|あの話|あっち)/;
const RISKY = /削除|消して|リセット|force|push|デプロイ|rm /i;

export interface RuleRouterOptions {
  name?: string;
  retrieve?: Retriever;
  /** 1位と2位の関連度の差がこれ未満なら「近い候補」として確認する */
  margin?: number;
  /** 1位の関連度がこれ未満なら、検索に手がかりなしとして扱う */
  minTop?: number;
  /** 明示Agentなしで、上位2件が別Agentのセッションなら確認する(同一テーマが複数Agentにある場合) */
  crossAgentConfirm?: boolean;
  /** 明示Agentなしで、現在のセッション以外へ自動送信するのに必要な最低関連度 */
  minAutoScore?: number;
  /** 「話は変わるが Codex で…」「あれどうなった」のような曖昧指示を確認に倒す */
  confirmVague?: boolean;
}

/** 規則(§5.3 の優先順位) + 差し替え可能なセッション検索。 */
export class RuleRouter implements Router {
  readonly name: string;
  private retrieve: Retriever;
  private margin: number;
  private minTop: number;
  private opts: RuleRouterOptions;

  constructor(o: RuleRouterOptions = {}) {
    this.name = o.name ?? "A:rules";
    this.retrieve = o.retrieve ?? keywordRetriever;
    this.margin = o.margin ?? 1;
    this.minTop = o.minTop ?? 0;
    this.opts = o;
  }

  route(utterance: string, ctx: RouterContext): RoutingDecision {
    const explicit = AGENT_PATTERNS.find(([, re]) => re.test(utterance))?.[0];
    const current = ctx.sessions.find((s) => s.id === ctx.currentSessionId);

    // 割り込み・読み上げは通常の送信と区別する(低遅延のためLLMを使わない)
    if (INTERRUPT.test(utterance)) return this.control("interrupt", explicit, current, ctx);
    if (READ_LATEST.test(utterance)) return this.control("read_latest", explicit, current, ctx);

    if (this.opts.confirmVague && VAGUE.test(utterance)) {
      return { destination: current?.agentId ?? "chat", sessionId: current?.id, action: "confirm", reason: "vague reference", candidates: current ? [{ destination: current.agentId, sessionId: current.id }] : [] };
    }
    if (this.opts.confirmVague && TOPIC_CHANGE.test(utterance) && explicit) {
      return { destination: explicit, action: "confirm", reason: "topic change with explicit agent: new or existing session?", candidates: [{ destination: explicit }] };
    }
    if (TOPIC_CHANGE.test(utterance)) {
      return { destination: explicit ?? "chat", action: "create", reason: "topic change marker" };
    }

    if (CONTINUE.test(utterance) && current && (!explicit || explicit === current.agentId)) {
      return this.guard(utterance, { destination: current.agentId, sessionId: current.id, action: "resume", reason: "continuation phrase" });
    }

    const pool = ctx.sessions.filter((s) => !explicit || s.agentId === explicit);
    const ranked = this.retrieve(utterance, pool).filter((x) => x.score >= this.minTop);

    const confirmWith = (reason: string, list: typeof ranked): RoutingDecision => ({
      destination: list[0].s.agentId,
      action: "confirm",
      reason,
      candidates: list.slice(0, 3).map((x) => ({ destination: x.s.agentId, sessionId: x.s.id })),
    });
    if (!explicit && ranked.length > 1 && this.opts.crossAgentConfirm && ranked[0].s.agentId !== ranked[1].s.agentId) {
      return confirmWith("same topic across agents", ranked);
    }
    if (!explicit && ranked.length && this.opts.minAutoScore !== undefined && ranked[0].score < this.opts.minAutoScore && ranked[0].s.id !== current?.id) {
      return confirmWith("weak evidence for auto dispatch", ranked);
    }
    if (ranked.length === 1 || (ranked.length > 1 && ranked[0].score - ranked[1].score >= this.margin)) {
      const s = ranked[0].s;
      return this.guard(utterance, { destination: s.agentId, sessionId: s.id, action: "resume", reason: `retrieval top (${ranked[0].score.toFixed(2)})` });
    }
    if (ranked.length > 1) {
      return {
        destination: ranked[0].s.agentId,
        action: "confirm",
        reason: "multiple close candidates",
        candidates: ranked.slice(0, 3).map((x) => ({ destination: x.s.agentId, sessionId: x.s.id })),
      };
    }

    if (explicit) {
      return { destination: explicit, action: "confirm", reason: "explicit agent but no matching session", candidates: [{ destination: explicit }] };
    }
    return this.guard(utterance, { destination: "chat", action: "create", reason: "no signal; default to general chat" });
  }

  /** 割り込み/読み上げの対象: 明示Agentがあればその最新セッション、なければ現在のセッション。 */
  private control(intent: "interrupt" | "read_latest", explicit: string | undefined, current: SessionIndex | undefined, ctx: RouterContext): RoutingDecision {
    let target = explicit && current?.agentId !== explicit
      ? ctx.sessions.filter((s) => s.agentId === explicit).sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))[0]
      : current;
    if (!target) return { intent, destination: explicit ?? "chat", action: "confirm", reason: `${intent}: no target session` };
    if (intent === "interrupt" && !target.capabilities.includes("interrupt")) {
      return { intent, destination: target.agentId, sessionId: target.id, action: "confirm", reason: "interrupt unsupported by target" };
    }
    return { intent, destination: target.agentId, sessionId: target.id, action: "resume", reason: `${intent} keyword` };
  }

  /** 高リスク語を含む場合は常に確認(§5.3 破壊的操作は確認を省略しない) */
  private guard(utterance: string, d: RoutingDecision): RoutingDecision {
    if (RISKY.test(utterance)) {
      return { ...d, action: "confirm", reason: `${d.reason}; risky operation`, candidates: [{ destination: d.destination, sessionId: d.sessionId }] };
    }
    return d;
  }
}
