import type { Router, RouterContext, RoutingDecision, SessionIndex } from "../../shared/src/types.ts";

const AGENT_PATTERNS: [string, RegExp][] = [
  ["codex", /codex|コーデックス|コデックス/i],
  ["openai", /chat ?gpt|チャットジーピーティー|openai/i],
];
const CONTINUE = /(その|この)(話|件)の?続き|続きを|さっきの|それについて/;
const TOPIC_CHANGE = /別の話|話は変わ|ところで|話題を変え/;
const RISKY = /削除|消して|リセット|force|push|デプロイ|rm /i;

function keywordHits(utterance: string, s: SessionIndex): number {
  return s.keywords.filter((k) => utterance.toLowerCase().includes(k.toLowerCase())).length;
}

/** 方式A: ルールのみ。設計書 §5.3 の優先順位に沿う。 */
export class RuleRouter implements Router {
  readonly name = "A:rules";

  route(utterance: string, ctx: RouterContext): RoutingDecision {
    const explicit = AGENT_PATTERNS.find(([, re]) => re.test(utterance))?.[0];
    const current = ctx.sessions.find((s) => s.id === ctx.currentSessionId);

    if (TOPIC_CHANGE.test(utterance)) {
      return { destination: explicit ?? "openai", action: "create", reason: "topic change marker" };
    }

    // 2. 継続指示は現在セッション(明示Agentと矛盾しない場合のみ)
    if (CONTINUE.test(utterance) && current && (!explicit || explicit === current.agentId)) {
      return this.guard(utterance, { destination: current.agentId, sessionId: current.id, action: "resume", reason: "continuation phrase" }, ctx);
    }

    // 1/4. Agent指定 + キーワード一致するセッション検索
    const pool = ctx.sessions.filter((s) => !explicit || s.agentId === explicit);
    const scored = pool
      .map((s) => ({ s, hits: keywordHits(utterance, s) }))
      .filter((x) => x.hits > 0)
      .sort((a, b) => b.hits - a.hits);

    if (scored.length === 1 || (scored.length > 1 && scored[0].hits > scored[1].hits)) {
      const s = scored[0].s;
      return this.guard(utterance, { destination: s.agentId, sessionId: s.id, action: "resume", reason: `keyword match (${scored[0].hits})` }, ctx);
    }
    if (scored.length > 1) {
      return {
        destination: scored[0].s.agentId,
        action: "confirm",
        reason: "multiple close candidates",
        candidates: scored.slice(0, 3).map((x) => ({ destination: x.s.agentId, sessionId: x.s.id })),
      };
    }

    // 3. 現在セッションとの関連性はルールでは判断不能 → 明示指定なしで文脈もなければ新規
    if (explicit) {
      return { destination: explicit, action: "confirm", reason: "explicit agent but no matching session", candidates: [{ destination: explicit }] };
    }
    return { destination: "openai", action: "create", reason: "no signal; default to general chat" };
  }

  /** 高リスク語を含む場合は常に確認(§5.3 破壊的操作は確認を省略しない) */
  private guard(utterance: string, d: RoutingDecision, _ctx: RouterContext): RoutingDecision {
    if (RISKY.test(utterance)) {
      return { ...d, action: "confirm", reason: `${d.reason}; risky operation`, candidates: [{ destination: d.destination, sessionId: d.sessionId }] };
    }
    return d;
  }
}
