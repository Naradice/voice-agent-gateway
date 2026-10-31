import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalLLMAdapter, OllamaLifecycle, Store, type AgentEvent } from "../src/index.ts";

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

const sseOf = (text: string) => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)); c.close(); } }));

async function runTurn(loaded: boolean) {
  const lc = fake((url) => (url.endsWith("/api/ps") ? json({ models: loaded ? [{ name: "m", size: 1, size_vram: 1 }] : [] }) : json({})));
  const adapter = new LocalLLMAdapter({
    store: new Store(), model: "m", fetch: (async () => sseOf("A")) as typeof fetch,
    lifecycle: new OllamaLifecycle({ model: "m", keepAlive: "15m", fetch: lc.f }),
  });
  const s = await adapter.createSession();
  const events: AgentEvent[] = [];
  const done = new Promise<void>((resolve) => adapter.subscribe(s.id, (e) => { events.push(e); if (e.type === "turn.completed") resolve(); }));
  await adapter.sendMessage(s.id, "q");
  await done;
  await new Promise((r) => setTimeout(r, 10)); // onTurnEnd は待たずに実行される
  return { events, calls: lc.calls };
}

test("a cold model is announced with a status event before the turn starts", async () => {
  const { events } = await runTurn(false);
  assert.deepEqual(events.slice(0, 2).map((e) => e.type), ["status", "turn.started"]);
  assert.equal((events[0] as any).code, "model_loading");
});

test("a loaded model produces no loading notice; the Gateway keep-alive is applied after each turn", async () => {
  const { events, calls } = await runTurn(true);
  assert.ok(!events.some((e) => e.type === "status"));
  const touch = calls.find((c) => c.url.endsWith("/api/generate"));
  assert.deepEqual(touch?.body, { model: "m", keep_alive: "15m" });
});
