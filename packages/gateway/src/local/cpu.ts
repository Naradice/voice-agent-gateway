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
          "CPU 専用の Ollama(npm run ollama:cpu)につながっていますか(OLLAMA_BASE_URL のポート)。GPU を隠す設定が効かない場合は、npm run ollama:model で GPU を使わない派生モデルを作ってください" };
  }
  return gpu >= 1
    ? { ok: true, message: `読み込み中: GPU で動いています(VRAM ${gb(s.vramBytes)} / ${ram})` }
    : { ok: false, message: `読み込み中: 一部が CPU で動いています(GPU ${Math.round(gpu * 100)}%、VRAM ${gb(s.vramBytes)})。他の用途で GPU が埋まっていると遅くなります` };
}

/**
 * Ollama の起動ログから、GPU が検出されたかを判定する。CPU 専用のつもりで起動したのに GPU が見つかっていれば、
 * 環境変数による無効化が効いていない。ログの形式はバージョンで違うため、library= の値で緩く判定する。
 */
export function detectGpuInLog(line: string): { gpu: boolean; cpu: boolean; library?: string; device?: string } {
  const lib = /\blibrary=("?)(\w+)\1/i.exec(line)?.[2]?.toLowerCase();
  if (/inference compute/i.test(line) || lib) {
    if (lib === "cpu") return { gpu: false, cpu: true };
    if (lib && ["cuda", "rocm", "hip", "metal", "vulkan", "oneapi", "sycl"].includes(lib)) {
      const device = /\b(?:name|description)="?([^"=]+?)"?(?:\s+\w+=|$)/i.exec(line)?.[1]?.trim();
      return { gpu: true, cpu: false, library: lib, device };
    }
  }
  return { gpu: false, cpu: false };
}

/** 派生モデルの名前。例: qwen3:4b → qwen3-4b-cpu */
export function cpuModelName(base: string): string {
  return `${base.replace(/-cpu$/, "").replace(/[:/]/g, "-")}-cpu`;
}

/**
 * GPU に載せる層の数を 0 にした派生モデルの Modelfile。環境変数で GPU を隠す方法に頼らず、モデルの側で CPU 実行を指定する。
 * num_ctx も固定する(Ollama の既定の文脈長は版によって変わり、メモリ使用量が増えるため)。
 */
export function cpuModelfile(base: string, numCtx = 4096): string {
  return `FROM ${base.replace(/-cpu$/, "")}\nPARAMETER num_gpu 0\nPARAMETER num_ctx ${numCtx}\n`;
}

/**
 * Ollama に接続できないときの案内。生のスタックトレースではなく、何を直せばよいかを示す。
 * 接続の失敗でなければ undefined(呼び出し側がそのまま投げ直す)。
 */
export function explainConnectionError(e: unknown, baseUrl = "http://127.0.0.1:11434/v1"): string | undefined {
  const code: string | undefined = (e as any)?.cause?.code ?? (e as any)?.code;
  const msg = e instanceof Error ? e.message : String(e);
  const connectionFailure = ["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "UND_ERR_CONNECT_TIMEOUT", "EHOSTUNREACH"].includes(code ?? "") || /fetch failed/i.test(msg);
  if (!connectionFailure) return undefined;
  const target = (() => { try { const u = new URL(baseUrl); return u.host; } catch { return baseUrl; } })();
  const lines = [`Ollama(${target})に接続できません(${code ?? msg})。`];
  if (portOf(baseUrl, 0) === CPU_OLLAMA_PORT) {
    lines.push(
      "  11435 は、環境変数で GPU を隠す別インスタンス(npm run ollama:cpu)の既定のポートです。起動していないようです。",
      "  この別インスタンスは必須ではありません。GPU を使わない派生モデル(npm run ollama:model)は、普段使いの Ollama でも有効です。",
      "  → .env の OLLAMA_BASE_URL を http://127.0.0.1:11434/v1 にする(または、その行を消す)。",
      "  別インスタンスを使い続ける場合は、別のウィンドウで npm run ollama:cpu を起動してください。",
    );
  } else {
    lines.push("  Ollama が起動しているか確認してください(タスクトレイの Ollama、または ollama serve)。");
  }
  return lines.join("\n");
}
