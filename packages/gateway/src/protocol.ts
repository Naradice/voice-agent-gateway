// Android ⇔ Gateway の WebSocket プロトコル (設計書 §8)。JSON テキストフレーム。
// Android はこの型だけに依存し、Agent 固有の情報は持たない(原則1)。

export type Priority = "critical" | "high" | "normal" | "low";
// critical: エラー・承認待ち / high: 作業完了 / normal: 通常回答 / low: 進捗 (§3.5)

export type RejectCode =
  | "busy" // 他のアプリが使用中(Codex Desktop など)
  | "usage_limit"
  | "not_found"
  | "unavailable"
  | "unsupported"
  | "protocol"
  | "ambiguous" // 宛先を決められなかった
  | "cancelled"
  | "invalid" // 要求が不正
  | "indeterminate"; // 前回の実行結果が不明。自動再送しない (§8.4)

export interface Candidate { destination: string; sessionId?: string; label: string }

export type ClientMessage =
  /** 接続直後の最初のメッセージ。lastEventId までは処理済みとして、それより後を再送する */
  | { type: "hello"; lastEventId?: string; instanceId?: string; client?: string }
  | { type: "message.send"; requestId: string; text: string; sessionId?: string }
  /** 確認要求への回答。choice は candidates の添字、またはキャンセル */
  | { type: "routing.confirm"; requestId: string; choice: number | "cancel" }
  | { type: "interrupt"; requestId: string; sessionId?: string }
  | { type: "ack"; eventId: string }
  /** PTT が押された。応答が近いことを知らせ、モデルの先読みなどを始めさせる(応答なし) */
  | { type: "ptt.start" };

export type ServerMessage =
  /** instanceId は Gateway の DB の識別子。端末は覚えておき、次の hello に載せる。変わったら ack の位置を捨てる */
  | { type: "hello.ok"; deviceId: string; serverTime: string; replay: number; instanceId: string }
  | { type: "request.accepted"; requestId: string; destination: string; sessionId?: string; intent: string; created?: boolean }
  | { type: "request.rejected"; requestId: string; code: RejectCode; message: string; retryable: boolean }
  | { type: "routing.confirmation_required"; requestId: string; prompt: string; candidates: Candidate[] }
  /**
   * 読み上げ要求。eventId があるイベントは Gateway に保存されており、端末は処理後に ack を返す。
   * ephemeral=true(eventId なし)は保存されない一時的な通知(例: モデル起動中)。端末は最後に処理した位置を更新してはならない。
   */
  | { type: "speech.enqueue"; eventId?: string; ephemeral?: boolean; priority: Priority; text: string; sessionId?: string; destination?: string }
  /** プロトコルレベルのエラー(不正なメッセージなど)。接続は維持する */
  | { type: "error"; code: "invalid" | "internal" | "not_ready"; message: string };

/** 永続化するイベント(eventId は保存時に採番される) */
export type PersistedEvent = Omit<Extract<ServerMessage, { type: "speech.enqueue" }>, "eventId" | "ephemeral">;

const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

export type ParseResult = { ok: true; msg: ClientMessage } | { ok: false; message: string };

export const MAX_TEXT = 2000;

export function parseClientMessage(raw: string): ParseResult {
  let m: any;
  try { m = JSON.parse(raw); } catch { return { ok: false, message: "JSON ではありません" }; }
  if (!m || typeof m !== "object" || typeof m.type !== "string") return { ok: false, message: "type がありません" };
  switch (m.type) {
    case "hello":
      if (m.lastEventId !== undefined && !/^\d{1,15}$/.test(String(m.lastEventId))) return { ok: false, message: "lastEventId が不正です" };
      if (m.instanceId !== undefined && !str(m.instanceId, 64)) return { ok: false, message: "instanceId が不正です" };
      return { ok: true, msg: { type: "hello", lastEventId: m.lastEventId === undefined ? undefined : String(m.lastEventId), instanceId: m.instanceId, client: typeof m.client === "string" ? m.client.slice(0, 64) : undefined } };
    case "message.send":
      if (!str(m.requestId, 64)) return { ok: false, message: "requestId が不正です" };
      if (!str(m.text, MAX_TEXT)) return { ok: false, message: "text が空、または長すぎます" };
      if (m.sessionId !== undefined && !str(m.sessionId, 128)) return { ok: false, message: "sessionId が不正です" };
      return { ok: true, msg: { type: "message.send", requestId: m.requestId, text: m.text, sessionId: m.sessionId } };
    case "routing.confirm":
      if (!str(m.requestId, 64)) return { ok: false, message: "requestId が不正です" };
      if (m.choice !== "cancel" && !(Number.isInteger(m.choice) && m.choice >= 0 && m.choice < 20)) return { ok: false, message: "choice が不正です" };
      return { ok: true, msg: { type: "routing.confirm", requestId: m.requestId, choice: m.choice } };
    case "interrupt":
      if (!str(m.requestId, 64)) return { ok: false, message: "requestId が不正です" };
      if (m.sessionId !== undefined && !str(m.sessionId, 128)) return { ok: false, message: "sessionId が不正です" };
      return { ok: true, msg: { type: "interrupt", requestId: m.requestId, sessionId: m.sessionId } };
    case "ptt.start":
      return { ok: true, msg: { type: "ptt.start" } };
    case "ack":
      if (!/^\d{1,15}$/.test(String(m.eventId))) return { ok: false, message: "eventId が不正です" };
      return { ok: true, msg: { type: "ack", eventId: String(m.eventId) } };
    default:
      return { ok: false, message: `未知の type: ${m.type.slice(0, 40)}` };
  }
}
