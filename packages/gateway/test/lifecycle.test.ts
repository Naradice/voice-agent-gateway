import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalLLMAdapter, OllamaLifecycle, Store } from "../src/index.ts";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

function fake(handler: (url: string, body: any) => Response) {
  const calls: { url: string; body: any }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    return handler(url, body);
  }) as typeof fetch;
  return { f, calls };
}

test("warm loads with keep_alive on the native API (a /v1 base URL is accepted) and reports GPU fraction", async () => {
  const { f, calls } = fake((url) => url.endsWith("/api/ps")
    ? json({ models: [{ name: "qwen3:14b", size: 12e9, size_vram: 12e9, expires_at: "2026-10-31T12:05:00Z" }] })
    : json({}));
  const lc = new OllamaLifecycle({ model: "qwen3:14b", baseUrl: "http://127.0.0.1:11434/v1", keepAlive: "3m", fetch: f });
  const r = await lc.warm();
  assert.equal(calls[0].url, "http://127.0.0.1:11434/api/generate");
  assert.deepEqual(calls[0].body, { model: "qwen3:14b", keep_alive: "3m" });
  assert.deepEqual([r.status.loaded, r.status.gpuFraction], [true, 1]);
});

test("unload sends keep_alive 0; status says not loaded when absent from /api/ps", async () => {
  const { f, calls } = fake((url) => (url.endsWith("/api/ps") ? json({ models: [] }) : json({})));
  const lc = new OllamaLifecycle({ model: "qwen3:14b", fetch: f });
  await lc.unload();
  assert.deepEqual(calls[0].body, { model: "qwen3:14b", keep_alive: 0 });
  assert.deepEqual(await lc.status(), { loaded: false });
});

test("a partially offloaded model is visible as gpuFraction < 1", async () => {
  const { f } = fake(() => json({ models: [{ name: "qwen3:14b", size: 10e9, size_vram: 6e9 }] }));
  assert.equal((await new OllamaLifecycle({ model: "qwen3:14b", fetch: f }).status()).gpuFraction, 0.6);
});

test("adapter.prepare warms the model and never throws when Ollama is down", async () => {
  const ok = fake(() => json({ models: [] }));
  const a = new LocalLLMAdapter({ store: new Store(), model: "m", lifecycle: new OllamaLifecycle({ model: "m", fetch: ok.f }) });
  await a.prepare();
  assert.equal(ok.calls[0].url, "http://127.0.0.1:11434/api/generate");

  const down = new LocalLLMAdapter({ store: new Store(), model: "m", lifecycle: new OllamaLifecycle({ model: "m", fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch }) });
  await assert.doesNotReject(down.prepare());
  await assert.doesNotReject(new LocalLLMAdapter({ store: new Store(), model: "m" }).prepare()); // lifecycle なしでも安全
});
