import type { ModelStatus } from "./lifecycle.ts";

export type Device = "cpu" | "gpu";

/** CPU 専用の Ollama を起動するときの既定のポート(普段使いの 11434 とは別にする)。 */
export const CPU_OLLAMA_PORT = 11435;

/** OLLAMA_BASE_URL(例 http://127.0.0.1:11435/v1)からポートを取り出す。未設定・不正なら fallback。 */
export function portOf(baseUrl: string | undefined, fallback = CPU_OLLAMA_PORT): number {
  if (!baseUrl) return fallback;
  try {
    const p = Number(new URL(baseUrl).port);
    return Number.isInteger(p) && p > 0 ? p : fallback;
  } catch {
    return fallback;
  }
}

/**
 * GPU を使わない Ollama を起動するための環境変数。
 * 無効な GPU ID を指定すると、Ollama は GPU を無視して CPU で動く(Ollama の公式の手順)。
 * 待ち受けは手元の PC だけ(127.0.0.1)にし、並列数と同時に載せるモデル数を1に絞ってメモリを節約する。
 */
export function cpuOnlyEnv(base: NodeJS.ProcessEnv, port: number): NodeJS.ProcessEnv {
  return {
    ...base,
    CUDA_VISIBLE_DEVICES: "-1", // NVIDIA
    ROCR_VISIBLE_DEVICES: "-1", // AMD (ROCm)
    HIP_VISIBLE_DEVICES: "-1",
    OLLAMA_HOST: `127.0.0.1:${port}`,
    OLLAMA_NUM_PARALLEL: "1",
    OLLAMA_MAX_LOADED_MODELS: "1",
  };
}

const gb = (n?: number) => (n === undefined ? "?" : `${(n / 1024 ** 3).toFixed(1)}GB`);

/** 読み込み済みモデルが、期待した装置(CPU か GPU)で動いているかを判定して、利用者向けの説明にする。 */
export function deviceVerdict(s: ModelStatus, expected: Device): { ok: boolean; message: string } {
  if (!s.loaded) return { ok: true, message: "解放済み(メモリも GPU も使っていません)" };
  const gpu = s.gpuFraction ?? 0;
  const ram = `モデル全体 ${gb(s.sizeBytes)}`;
  if (expected === "cpu") {
    return gpu === 0
      ? { ok: true, message: `読み込み中: CPU のみで動いています(想定どおり。${ram}、VRAM 0)` }
      : { ok: false, message: `読み込み中: GPU を使っています(VRAM ${gb(s.vramBytes)}、${Math.round(gpu * 100)}%)。` +
          "CPU 専用の Ollama(npm run ollama:cpu)につながっていますか。OLLAMA_BASE_URL のポートを確認してください" };
  }
  return gpu >= 1
    ? { ok: true, message: `読み込み中: GPU で動いています(VRAM ${gb(s.vramBytes)} / ${ram})` }
    : { ok: false, message: `読み込み中: 一部が CPU で動いています(GPU ${Math.round(gpu * 100)}%、VRAM ${gb(s.vramBytes)})。他の用途で GPU が埋まっていると遅くなります` };
}
