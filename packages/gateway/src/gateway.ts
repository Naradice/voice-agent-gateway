import type { Router, RoutingDecision } from "../../shared/src/types.ts";
import { AgentError, type AgentAdapter, type AgentEvent } from "./adapter.ts";
import { SessionCatalog } from "./catalog.ts";
import type { Candidate, ClientMessage, PersistedEvent, Priority, RejectCode, ServerMessage } from "./protocol.ts";
import type { AdapterRegistry } from "./registry.ts";
import { SentenceStream, formatForSpeech } from "./speech.ts";
import type { RequestRecord, Store } from "./store.ts";

/** 「待機メッセージを読んで」など。Gateway が直接答える(Agent には送らない) */
export const isNoticeRequest = (text: string): boolean => /待機(中の)?(メッセージ|通知)|未読(の)?(メッセージ|通知)|通知を(読|聞|教)|新着(の)?(通知|メッセージ)/.test(text);

/** 端末への送信口。伝送路(WebSocket)から Gateway を切り離す。 */
export interface DeviceLink { send(msg: ServerMessage): void }

type Log = (level: "info" | "warn" | "error", msg: string, meta?: object) => void;

export interface GatewayOptions {
  store: Store;
  registry: AdapterRegistry;
  router: Router;
  /** 回答を文単位で読み始める宛先。既定 chat のみ。Codex は途中の発言が多いので最終回答だけ読む */
  streamSentences?: ReadonlySet<string>;
  /** 宛先ごとの通常回答の優先度。既定: chat=normal、それ以外=high(作業完了) */
  priorities?: Record<string, Priority>;
  labels?: Record<string, string>;
  /** 1ターンで読み上げる最大文字数(超えた分は省略し、全文は履歴に残る)。既定 600 */
  maxSpeechChars?: number;
  catalogTtlMs?: number;
  /** この Gateway が Agent へ指示を送る直前に呼ぶ(自分の指示による更新を、待機メッセージにしないため) */
  onOwnSend?: (destination: string, sessionId: string) => void;
  log?: Log;
}

interface TurnSpeech { stream: SentenceStream; streamed: boolean; spoken: number; capped: boolean }

const HOUR = 3_600_000;

const SPEECH_FOR_ERROR: Record<string, string> = {
  busy: "別のアプリでそのセッションが使用中です。パソコン側で閉じてから、もう一度お試しください。",
  usage_limit: "利用上限に達しているため、実行できません。",
  not_found: "対象が見つかりません。",
  unsupported: "その操作には対応していません。",
  protocol: "予期しないエラーが発生しました。",
  unavailable: "接続できません。しばらくしてからお試しください。",
};

export function speechForError(e: AgentError): string {
  // unavailable は Adapter が状況に応じた日本語メッセージを持つ(例: ローカルLLMが起動していない)
  if (e.kind === "unavailable" && /[ぁ-ん]/.test(e.message)) return e.message;
  return SPEECH_FOR_ERROR[e.kind] ?? SPEECH_FOR_ERROR.protocol;
}

export class Gateway {
  readonly catalog: SessionCatalog;
  private o: GatewayOptions;
  private links = new Map<string, DeviceLink>();
  private inflight = new Set<string>();
  private owners = new Map<string, string>(); // セッション → 最後に指示した端末
  private subscriptions = new Map<string, () => void>();
  private turns = new Map<string, TurnSpeech>();
  private log: Log;

  constructor(o: GatewayOptions) {
    this.o = o;
    this.log = o.log ?? (() => {});
    this.catalog = new SessionCatalog(o.registry, o.catalogTtlMs, this.log);
    const n = o.store.markInterruptedRequestsIndeterminate();
    if (n) this.log("warn", "requests left in flight by a previous run were marked indeterminate", { count: n });
  }

  // ---- 接続 ----

  /** この Gateway の DB の識別子(端末が ack の位置の有効性を判断するのに使う)。 */
  instanceId(): string {
    return this.o.store.instanceId();
  }

  /** 端末の接続を登録し、hello.ok と未 ack のイベントを送る。lastEventId までは処理済みとして削除する。 */
  attach(deviceId: string, link: DeviceLink, lastEventId?: string, instanceId?: string): number {
    this.links.set(deviceId, link);
    const { store } = this.o;
    const mine = store.instanceId();
    // 端末が見ていたのが別の DB(作り直した・別の Gateway)なら、その番号は意味が違う。削除せず、全件を再送する。
    if (lastEventId && (instanceId === undefined || instanceId === mine)) store.ackThrough(deviceId, Number(lastEventId));
    else if (lastEventId) this.log("warn", "ignoring ack position from a different gateway instance", { deviceId });
    store.pruneEvents(new Date(Date.now() - 24 * HOUR).toISOString());
    store.pruneRequests(new Date(Date.now() - 7 * 24 * HOUR).toISOString());
    const pending = store.eventsAfter(deviceId, 0);
    link.send({ type: "hello.ok", deviceId, serverTime: new Date().toISOString(), replay: pending.length, instanceId: mine });
    for (const e of pending) link.send({ ...e.payload, eventId: String(e.seq) });
    store.pruneNotices(new Date(Date.now() - 3 * 24 * HOUR).toISOString(), 50);
    // 未読があるときだけ知らせる。0 件は、端末が接続のたびに 0 から始める(protocol.md)
    if (store.pendingNotices().length > 0) link.send(this.noticesMessage());
    return pending.length;
  }

  // ---- 待機メッセージ ----

  private noticesMessage(): ServerMessage {
    const pending = this.o.store.pendingNotices();
    return { type: "notices", count: pending.length, ...(pending.length ? { latest: pending[pending.length - 1].text } : {}) };
  }

  private broadcastNotices(): void {
    const m = this.noticesMessage();
    for (const link of this.links.values()) link.send(m);
  }

  /** 自動では読み上げない通知を保持し、接続中の端末に件数を知らせる。 */
  notify(n: { kind: string; text: string; sessionId?: string; destination?: string }): void {
    this.o.store.addNotice(n);
    this.o.store.pruneNotices(new Date(Date.now() - 3 * 24 * HOUR).toISOString(), 50);
    this.broadcastNotices();
  }

  /** 未読を読み上げ、既読にする。一度に読むのは最大 8 件(残りは次回)。 */
  private readNotices(deviceId: string): void {
    const { store } = this.o;
    const pending = store.pendingNotices();
    if (pending.length === 0) return this.speak(deviceId, { type: "speech.enqueue", priority: "normal", text: "待機メッセージはありません。" });
    const batch = pending.slice(0, 8);
    const rest = pending.length - batch.length;
    const text = [`待機メッセージが${pending.length}件あります。`, ...batch.map((n, i) => `${i + 1}件目。${n.text}`), rest > 0 ? `残り${rest}件は、もう一度お願いします。` : ""].filter(Boolean).join(" ");
    this.speak(deviceId, { type: "speech.enqueue", priority: "normal", text });
    store.markNoticesRead(batch.map((n) => n.id));
    this.broadcastNotices();
  }

  detach(deviceId: string, link: DeviceLink): void {
    if (this.links.get(deviceId) === link) this.links.delete(deviceId);
  }

  async handle(deviceId: string, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case "message.send": return this.guarded(deviceId, msg.requestId, () => this.onSend(deviceId, msg.requestId, msg.text, msg.sessionId));
      case "routing.confirm": return this.guarded(deviceId, msg.requestId, () => this.onConfirm(deviceId, msg.requestId, msg.choice));
      case "interrupt": return this.guarded(deviceId, msg.requestId, () => this.onInterrupt(deviceId, msg.requestId, msg.sessionId));
      case "ack": this.o.store.ackThrough(deviceId, Number(msg.eventId)); return;
      case "ptt.start":
        // 発話・音声認識の間に準備を済ませる。失敗しても何も起きない(実際の要求時に再試行される)。
        for (const a of this.o.registry.list()) void a.prepare?.().catch(() => {});
        return;
      case "hello": return; // 伝送路が処理済み
    }
  }

  // ---- 送信ヘルパ ----

  private sendTo(deviceId: string, msg: ServerMessage): void {
    this.links.get(deviceId)?.send(msg);
  }

  /** 読み上げ要求。persist なら保存して eventId を付ける(切断中でも後で再送できる)。 */
  private speak(deviceId: string, e: PersistedEvent, persist = true): void {
    if (persist) {
      const seq = this.o.store.appendEvent(deviceId, e);
      this.sendTo(deviceId, { ...e, eventId: String(seq) });
    } else {
      this.sendTo(deviceId, { ...e, ephemeral: true });
    }
  }

  private reject(deviceId: string, requestId: string, code: RejectCode, message: string, retryable = false, record = true): void {
    if (record) this.o.store.putRequest(deviceId, requestId, "failed", { code, message, retryable });
    this.sendTo(deviceId, { type: "request.rejected", requestId, code, message, retryable });
  }

  private rejectWith(deviceId: string, requestId: string, e: unknown): void {
    const err = e instanceof AgentError ? e : new AgentError("protocol", e instanceof Error ? e.message : String(e));
    this.reject(deviceId, requestId, err.kind, speechForError(err), err.retryable);
  }

  /** 同じ要求の同時実行を避け、予期しない例外を握りつぶさず端末に伝える。 */
  private async guarded(deviceId: string, requestId: string, fn: () => Promise<void>): Promise<void> {
    const key = `${deviceId}/${requestId}`;
    if (this.inflight.has(key)) return; // 処理中の重複。完了時に結果が返る
    this.inflight.add(key);
    try {
      await fn();
    } catch (e) {
      this.log("error", "request failed unexpectedly", { requestId, error: String(e) });
      this.rejectWith(deviceId, requestId, e);
    } finally {
      this.inflight.delete(key);
    }
  }

  // ---- 要求の処理 ----

  private replay(deviceId: string, requestId: string, rec: RequestRecord): void {
    switch (rec.state) {
      case "accepted":
        return this.sendTo(deviceId, { type: "request.accepted", requestId, ...rec.result });
      case "failed":
        return this.sendTo(deviceId, { type: "request.rejected", requestId, ...rec.result });
      case "cancelled":
        return this.sendTo(deviceId, { type: "request.rejected", requestId, code: "cancelled", message: "キャンセルしました。", retryable: false });
      case "awaiting_confirmation":
        return this.sendTo(deviceId, { type: "routing.confirmation_required", requestId, prompt: rec.result.prompt, candidates: rec.result.candidates });
      default:
        // 外部Agentに届いたか分からない。Gateway だけでは Exactly-Once を保証できないので、自動で再実行しない (§8.4)。
        return this.sendTo(deviceId, {
          type: "request.rejected", requestId, code: "indeterminate", retryable: false,
          message: "前回の指示が実行されたか確認できません。結果を確認してから、もう一度指示してください。",
        });
    }
  }

  private async onSend(deviceId: string, requestId: string, text: string, sessionId?: string): Promise<void> {
    const { store } = this.o;
    const prev = store.getRequest(deviceId, requestId);
    if (prev) return this.replay(deviceId, requestId, prev);
    store.putRequest(deviceId, requestId, "received");

    if (isNoticeRequest(text)) {
      this.readNotices(deviceId);
      const result = { destination: "gateway", intent: "read_notices" };
      store.putRequest(deviceId, requestId, "accepted", result);
      return this.sendTo(deviceId, { type: "request.accepted", requestId, ...result });
    }

    const sessions = await this.catalog.list();
    let decision: RoutingDecision;
    if (sessionId) {
      const s = sessions.find((x) => x.id === sessionId);
      if (!s) return this.reject(deviceId, requestId, "not_found", SPEECH_FOR_ERROR.not_found);
      decision = { destination: s.agentId, sessionId: s.id, action: "resume", reason: "explicit session" };
    } else {
      decision = this.o.router.route(text, { currentSessionId: store.getCurrentSession(deviceId), sessions });
    }
    store.recordRouting(deviceId, requestId, text, decision);

    if (decision.action === "reject") return this.reject(deviceId, requestId, "invalid", decision.reason);
    if (decision.action === "confirm") return this.askConfirmation(deviceId, requestId, text, decision);
    await this.dispatch(deviceId, requestId, text, decision);
  }

  private label(c: { destination: string; sessionId?: string }): string {
    const agent = this.o.labels?.[c.destination] ?? ({ chat: "チャット", codex: "Codex" } as Record<string, string>)[c.destination] ?? c.destination;
    const title = c.sessionId ? this.catalog.find(c.sessionId)?.title : undefined;
    return `${agent}の${title ? `「${title}」` : "新しい会話"}`;
  }

  private askConfirmation(deviceId: string, requestId: string, text: string, d: RoutingDecision): void {
    if (d.intent === "interrupt") return this.reject(deviceId, requestId, "unsupported", "そのセッションは音声での中断に対応していません。");
    const candidates: Candidate[] = (d.candidates ?? []).map((c) => ({ ...c, label: this.label(c) }));
    if (candidates.length === 0) return this.reject(deviceId, requestId, "ambiguous", "どの会話か分かりませんでした。もう少し具体的にお願いします。");
    const prompt = candidates.length === 1
      ? `${candidates[0].label}に送ってよいですか。`
      : `どちらですか。${candidates.map((c, i) => `${i + 1}番、${c.label}`).join("。")}。キャンセルもできます。`;
    this.o.store.putRequest(deviceId, requestId, "awaiting_confirmation", { text, candidates, intent: d.intent ?? "send", prompt });
    this.sendTo(deviceId, { type: "routing.confirmation_required", requestId, prompt, candidates });
  }

  private async onConfirm(deviceId: string, requestId: string, choice: number | "cancel"): Promise<void> {
    const { store } = this.o;
    const rec = store.getRequest(deviceId, requestId);
    if (!rec || rec.state !== "awaiting_confirmation") {
      return this.reject(deviceId, requestId, "invalid", "確認待ちの指示がありません。", false, false);
    }
    if (choice === "cancel") {
      store.putRequest(deviceId, requestId, "cancelled");
      return this.sendTo(deviceId, { type: "request.rejected", requestId, code: "cancelled", message: "キャンセルしました。", retryable: false });
    }
    const cand: Candidate | undefined = rec.result.candidates[choice];
    if (!cand) return this.reject(deviceId, requestId, "invalid", "その選択肢はありません。", false, false);
    await this.dispatch(deviceId, requestId, rec.result.text, {
      destination: cand.destination, sessionId: cand.sessionId, action: cand.sessionId ? "resume" : "create",
      intent: rec.result.intent, reason: "confirmed by user",
    });
  }

  private async onInterrupt(deviceId: string, requestId: string, sessionId?: string): Promise<void> {
    const { store } = this.o;
    const prev = store.getRequest(deviceId, requestId);
    if (prev) return this.replay(deviceId, requestId, prev);
    store.putRequest(deviceId, requestId, "received");
    const target = sessionId ?? store.getCurrentSession(deviceId);
    const s = target ? (await this.catalog.list()).find((x) => x.id === target) : undefined;
    if (!s) return this.reject(deviceId, requestId, "not_found", "中断する会話がありません。");
    if (!s.capabilities.includes("interrupt")) return this.reject(deviceId, requestId, "unsupported", "そのセッションは音声での中断に対応していません。");
    await this.dispatch(deviceId, requestId, "", { destination: s.agentId, sessionId: s.id, action: "resume", intent: "interrupt", reason: "interrupt request" });
  }

  private async dispatch(deviceId: string, requestId: string, text: string, d: RoutingDecision): Promise<void> {
    const { store } = this.o;
    const adapter = this.o.registry.get(d.destination);
    if (!adapter) return this.reject(deviceId, requestId, "unsupported", `宛先「${d.destination}」は利用できません。`);

    // 外部Agentへ触れる前に記録する。ここから先でクラッシュすると、再起動後は「結果不明」になる。
    store.putRequest(deviceId, requestId, "dispatching", { decision: d });
    const intent = d.intent ?? "send";
    try {
      let sessionId = d.sessionId;
      let created = false;
      if (!sessionId || d.action === "create") {
        if (intent !== "send") throw new AgentError("not_found", "対象の会話がありません");
        if (!adapter.createSession) throw new AgentError("unsupported", "この宛先では新しい会話を作れません");
        sessionId = (await adapter.createSession()).id;
        created = true;
        this.catalog.invalidate();
      }
      this.ensureSubscribed(adapter, sessionId);
      this.owners.set(sessionId, deviceId);

      if (intent === "send") {
        this.turns.set(sessionId, { stream: new SentenceStream(), streamed: false, spoken: 0, capped: false });
        this.o.onOwnSend?.(d.destination, sessionId);
        await adapter.sendMessage(sessionId, text);
        store.setCurrentSession(deviceId, sessionId);
      } else if (intent === "interrupt") {
        await adapter.interrupt(sessionId);
      } else {
        await this.readLatest(deviceId, adapter, sessionId);
      }

      const result = { destination: d.destination, sessionId, intent, created };
      store.putRequest(deviceId, requestId, "accepted", result);
      this.sendTo(deviceId, { type: "request.accepted", requestId, ...result });
    } catch (e) {
      this.rejectWith(deviceId, requestId, e);
    }
  }

  private async readLatest(deviceId: string, adapter: AgentAdapter, sessionId: string): Promise<void> {
    const history = await adapter.readHistory(sessionId);
    const last = [...history].reverse().find((h) => h.kind === "agent" && h.text);
    const text = last ? formatForSpeech(last.text!, { maxChars: this.o.maxSpeechChars ?? 600 }) : "返答はまだありません。";
    this.speak(deviceId, { type: "speech.enqueue", priority: "normal", text, sessionId, destination: adapter.agentType });
  }

  // ---- Agent のイベント → 読み上げ (Event Router) ----

  private ensureSubscribed(adapter: AgentAdapter, sessionId: string): void {
    const key = `${adapter.agentType}:${sessionId}`;
    if (this.subscriptions.has(key)) return;
    this.subscriptions.set(key, adapter.subscribe(sessionId, (e) => this.onAgentEvent(adapter.agentType, e)));
  }

  private onAgentEvent(destination: string, e: AgentEvent): void {
    const deviceId = this.owners.get(e.sessionId);
    if (!deviceId) return;
    const base = { type: "speech.enqueue" as const, sessionId: e.sessionId, destination };
    const normal: Priority = this.o.priorities?.[destination] ?? (destination === "chat" ? "normal" : "high");
    const streaming = (this.o.streamSentences ?? new Set(["chat"])).has(destination);
    const turn = this.turns.get(e.sessionId) ?? { stream: new SentenceStream(), streamed: false, spoken: 0, capped: false };
    this.turns.set(e.sessionId, turn);

    const say = (text: string, priority: Priority = normal) => {
      const max = this.o.maxSpeechChars ?? 600;
      turn.spoken += text.length;
      if (turn.spoken > max) {
        if (!turn.capped) { turn.capped = true; this.speak(deviceId, { ...base, priority, text: "以降は省略します。" }); }
        return;
      }
      this.speak(deviceId, { ...base, priority, text });
    };

    switch (e.type) {
      case "status":
        this.speak(deviceId, { ...base, priority: "normal", text: e.message }, false); // 一時的な通知。切断中に貯めない
        break;
      case "message.delta":
        if (streaming) { turn.streamed = true; for (const s of turn.stream.push(e.text)) say(s); }
        break;
      case "message.completed":
        if (e.phase && e.phase !== "final_answer") break; // 途中経過は読まない
        if (streaming && turn.streamed) for (const s of turn.stream.flush()) say(s);
        else say(formatForSpeech(e.text, { maxChars: this.o.maxSpeechChars ?? 600 }));
        break;
      case "request.unhandled":
        this.speak(deviceId, { ...base, priority: "critical", text: "確認を求められました。パソコンで確認してください。" });
        break;
      case "warning":
        this.log("warn", e.message, { sessionId: e.sessionId, code: e.code });
        break;
      case "turn.completed":
        if (e.status === "error" && e.error) this.speak(deviceId, { ...base, priority: "critical", text: speechForError(e.error) });
        this.turns.delete(e.sessionId);
        break;
      default:
        break; // turn.started / error(turn.completed で扱う)
    }
  }
}
