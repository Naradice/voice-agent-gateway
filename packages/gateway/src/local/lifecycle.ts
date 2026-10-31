/** Ollama はタグのないモデル名に :latest を付けて返す(例 qwen3-4b-cpu → qwen3-4b-cpu:latest)。照合のために揃える。 */
export const withTag = (name: string): string => (name.includes(":") ? name : `${name}:latest`);

export interface OllamaLifecycleOptions {
  model: string;
  /** Ollama の基点。/v1 付き(OpenAI互換側)を渡しても、末尾の /v1 を除いてネイティブAPIに使う。既定 http://127.0.0.1:11434 */
  baseUrl?: string;
  /** warm() で読み込んだ後に常駐させる時間。数値は秒、文字列は "5m" など。既定 "5m" */
  keepAlive?: string | number;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ModelStatus {
  loaded: boolean;
  sizeBytes?: number;
  vramBytes?: number;
  /** VRAM に載っている割合(0〜1)。1 未満は一部が CPU で動いており、遅くなる */
  gpuFraction?: number;
  expiresAt?: string;
}

/**
 * Ollama のモデルの読み込み・解放を制御する(GPU を常時占有しないため)。
 * 空のリクエストで読み込み、keep_alive を 0 にして解放する。OpenAI互換の /v1 は keep_alive を受け付けないため、ネイティブAPIを使う。
 * 実機の Ollama では未確認。
 */
export class OllamaLifecycle {
  private o: OllamaLifecycleOptions;
  private root: string;

  constructor(opts: OllamaLifecycleOptions) {
    this.o = opts;
    this.root = (opts.baseUrl ?? "http://127.0.0.1:11434").replace(/\/v1\/?$/, "").replace(/\/$/, "");
  }

  private async call(path: string, init?: RequestInit): Promise<any> {
    const res = await (this.o.fetch ?? fetch)(`${this.root}${path}`, { ...init, signal: AbortSignal.timeout(this.o.timeoutMs ?? 120_000) });
    if (!res.ok) throw new Error(`Ollama ${path}: HTTP ${res.status}`);
    return res.json().catch(() => ({}));
  }

  private generate(keepAlive: string | number) {
    return this.call("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.o.model, keep_alive: keepAlive }),
    });
  }

  /** 読み込む(すでに載っていれば常駐時間だけ延長される)。完了までの時間と状態を返す。 */
  async warm(): Promise<{ loadMs: number; status: ModelStatus }> {
    const t0 = Date.now();
    await this.generate(this.o.keepAlive ?? "5m");
    return { loadMs: Date.now() - t0, status: await this.status() };
  }

  /** 読み込み済みのモデルの常駐時間を、設定した keepAlive で更新する(使用後に呼ぶと、最後の使用から keepAlive 後に解放される)。 */
  async touch(): Promise<void> {
    await this.generate(this.o.keepAlive ?? "5m");
  }

  /** 解放する。実験などで GPU を空けたいとき。 */
  async unload(): Promise<void> {
    await this.generate(0);
  }

  async status(): Promise<ModelStatus> {
    const j = await this.call("/api/ps");
    const want = withTag(this.o.model);
    const m = (j?.models ?? []).find((x: any) => withTag(String(x.name ?? "")) === want || withTag(String(x.model ?? "")) === want);
    if (!m) return { loaded: false };
    return {
      loaded: true,
      sizeBytes: m.size,
      vramBytes: m.size_vram,
      gpuFraction: m.size ? Math.min(1, (m.size_vram ?? 0) / m.size) : undefined,
      expiresAt: m.expires_at,
    };
  }
}
