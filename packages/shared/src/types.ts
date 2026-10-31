// 設計書 §5.4 / §5.7 / §6.1 の共通型。Agent固有の型はここに持ち込まない。

export interface SessionIndex {
  id: string;
  agentId: string;
  externalSessionId?: string;
  title: string;
  summary: string;
  keywords: string[];
  lastActiveAt: string;
  capabilities: string[];
}

export type RoutingAction = "resume" | "create" | "confirm" | "reject";

export interface RoutingDecision {
  destination: string;
  sessionId?: string;
  action: RoutingAction;
  confidence?: number;
  reason: string;
  /** confirm 時の候補。設計書 §8.2 の routing.confirmation_required に対応 */
  candidates?: { destination: string; sessionId?: string }[];
}

export interface RouterContext {
  /** 直前に会話していたセッション */
  currentSessionId?: string;
  sessions: SessionIndex[];
}

export interface Router {
  readonly name: string;
  route(utterance: string, ctx: RouterContext): RoutingDecision;
}

export type AgentCapability =
  | "list_sessions"
  | "read_history"
  | "send_message"
  | "subscribe"
  | "interrupt";
