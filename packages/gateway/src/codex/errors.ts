import { AgentError } from "../adapter.ts";
import { RpcError } from "./client.ts";

/**
 * Codex の失敗を共通のエラー種別に写す。判定は実機で観測した文言に基づく(Phase 0A)。
 * 文言が変わると not_found/protocol に落ちる。alpha 版のため、変更を検知できるよう生メッセージを cause に残す。
 */
export function mapCodexError(e: unknown): AgentError {
  if (e instanceof AgentError) return e;
  const message = e instanceof Error ? e.message : String(e);
  if (/active writer/i.test(message)) return new AgentError("busy", "Codex で別のアプリがこのスレッドを開いています", { cause: e });
  if (/usage limit/i.test(message)) return new AgentError("usage_limit", "Codex の利用上限に達しています", { retryable: false, cause: e });
  if (/thread not found|not found/i.test(message)) return new AgentError("not_found", "Codex のスレッドが見つかりません", { cause: e });
  return new AgentError("protocol", e instanceof RpcError ? `Codex RPC error ${e.code}: ${message}` : message, { cause: e });
}
