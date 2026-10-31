import type { AgentCapability, Router, RouterContext, RoutingDecision } from "../../shared/src/types.ts";
import { AgentError, type AgentAdapter, type AgentEvent, type AgentSession, type HistoryItem } from "../src/adapter.ts";
import { Gateway, type GatewayOptions } from "../src/gateway.ts";
import type { ServerMessage } from "../src/protocol.ts";
import { AdapterRegistry } from "../src/registry.ts";
import { Store } from "../src/store.ts";

export class FakeAdapter implements AgentAdapter {
  readonly agentType: string;
  readonly capabilities: ReadonlySet<AgentCapability>;
  sessions: AgentSession[] = [];
  history: Record<string, HistoryItem[]> = {};
  sent: { sessionId: string; text: string }[] = [];
  interrupted: string[] = [];
  failNext?: AgentError;
  prepared = 0;
  listError?: Error;
  private subs = new Map<string, Set<(e: AgentEvent) => void>>();

  constructor(agentType: string, caps: AgentCapability[], sessions: AgentSession[] = []) {
    this.agentType = agentType;
    this.capabilities = new Set(caps);
    this.sessions = sessions;
  }

  async listSessions() { if (this.listError) throw this.listError; return this.sessions; }
  async getSession(id: string) { const s = this.sessions.find((x) => x.id === id); if (!s) throw new AgentError("not_found", "x"); return s; }
  async readHistory(id: string) { return this.history[id] ?? []; }
  async createSession() {
    const s = { id: `${this.agentType}-new-${this.sessions.length + 1}`, agentId: this.agentType, title: "新しい会話", updatedAt: new Date().toISOString() };
    this.sessions.push(s);
    return s;
  }
  async sendMessage(sessionId: string, text: string) {
    if (this.failNext) { const e = this.failNext; this.failNext = undefined; throw e; }
    this.sent.push({ sessionId, text });
  }
  async interrupt(sessionId: string) { this.interrupted.push(sessionId); }
  async prepare() { this.prepared++; }
  subscribe(sessionId: string, cb: (e: AgentEvent) => void) {
    const set = this.subs.get(sessionId) ?? new Set();
    set.add(cb);
    this.subs.set(sessionId, set);
    return () => { set.delete(cb); };
  }
  emit(e: AgentEvent) { for (const cb of this.subs.get(e.sessionId) ?? []) cb(e); }
}

export class StubRouter implements Router {
  readonly name = "stub";
  decision: RoutingDecision | ((text: string, ctx: RouterContext) => RoutingDecision);
  last?: { text: string; ctx: RouterContext };
  constructor(decision: StubRouter["decision"]) { this.decision = decision; }
  route(text: string, ctx: RouterContext) {
    this.last = { text, ctx };
    return typeof this.decision === "function" ? this.decision(text, ctx) : this.decision;
  }
}

export const session = (id: string, agentId: string, title: string): AgentSession => ({ id, agentId, title, updatedAt: "2026-10-31T00:00:00Z" });

export function setup(opts: { router?: StubRouter; store?: Store; gateway?: Partial<GatewayOptions>; codexCaps?: AgentCapability[] } = {}) {
  const store = opts.store ?? new Store();
  const chat = new FakeAdapter("chat", ["list_sessions", "read_history", "send_message", "subscribe", "interrupt", "create_session"], [session("c1", "chat", "雑談")]);
  const codex = new FakeAdapter("codex", opts.codexCaps ?? ["list_sessions", "read_history", "send_message", "subscribe"], [session("x1", "codex", "JEPA実験")]);
  const registry = new AdapterRegistry();
  registry.register(chat);
  registry.register(codex);
  const router = opts.router ?? new StubRouter({ destination: "chat", sessionId: "c1", action: "resume", reason: "stub" });
  const gw = new Gateway({ store, registry, router, ...opts.gateway });
  const out: ServerMessage[] = [];
  const link = { send: (m: ServerMessage) => { out.push(m); } };
  gw.attach("dev1", link);
  out.length = 0; // hello.ok は除く
  return { gw, store, chat, codex, router, out, link, registry };
}

export const speeches = (out: ServerMessage[]) => out.filter((m): m is Extract<ServerMessage, { type: "speech.enqueue" }> => m.type === "speech.enqueue");
export const ofType = <T extends ServerMessage["type"]>(out: ServerMessage[], t: T) => out.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === t);
