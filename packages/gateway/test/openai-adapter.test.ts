import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentError, OpenAIAdapter, Store, type AgentEvent } from "../src/index.ts";

const enc = new TextEncoder();
const sse = (events: object[]) => events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");
const textResponse = (events: object[], status = 200) =>
  new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(sse(events))); c.close(); } }), { status, headers: { "content-type": "text/event-stream" } });
const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

interface Call { url: string; headers: Record<string, string>; body: any }

function setup(handler: (call: Call, init: RequestInit) => Response | Promise<Response>, extra: object = {}) {
  const calls: Call[] = [];
  const store = new Store();
  const adapter = new OpenAIAdapter({
    store, apiKey: "sk-test-secret", model: "test-model", instructions: "be brief", ...extra,
    fetch: (async (url: string, init: RequestInit) => {
      const call = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
      calls.push(call);
      return handler(call, init);
    }) as typeof fetch,
  });
  return { adapter, store, calls };
}

const untilCompleted = (adapter: OpenAIAdapter, sessionId: string) =>
  new Promise<AgentEvent[]>((resolve) => {
    const events: AgentEvent[] = [];
    const off = adapter.subscribe(sessionId, (e) => { events.push(e); if (e.type === "turn.completed") { off(); resolve(events); } });
  });

const okStream = (text: string[]) => [
  ...text.map((d) => ({ type: "response.output_text.delta", delta: d })),
  { type: "response.completed", response: { usage: { input_tokens: 12, output_tokens: 3 } } },
];

test("streams deltas, persists both messages, records usage, and sends store:false with the key only in the header", async () => {
  const { adapter, store, calls } = setup(() => textResponse(okStream(["こん", "にちは"])));
  const s = await adapter.createSession();
  const done = untilCompleted(adapter, s.id);
  await adapter.sendMessage(s.id, "やあ");
  const events = await done;

  assert.deepEqual(events.map((e) => e.type), ["turn.started", "message.delta", "message.delta", "message.completed", "turn.completed"]);
  assert.equal((events.at(-1) as any).status, "ok");
  assert.deepEqual(store.messages(s.id).map((m) => [m.role, m.text]), [["user", "やあ"], ["assistant", "こんにちは"]]);
  assert.deepEqual(store.usageTotals(), { inputTokens: 12, outputTokens: 3, requests: 1 });
  assert.equal(calls[0].headers.authorization, "Bearer sk-test-secret");
  assert.ok(!JSON.stringify(calls[0].body).includes("sk-test-secret"));
  assert.equal(calls[0].body.store, false);
  assert.equal(calls[0].body.stream, true);
  assert.equal(calls[0].body.model, "test-model");
  assert.equal(calls[0].body.instructions, "be brief");
  assert.equal((await adapter.getSession(s.id)).title, "やあ");
});

test("later turns send the stored history", async () => {
  const { adapter, calls } = setup(() => textResponse(okStream(["A"])));
  const s = await adapter.createSession();
  for (const q of ["one", "two"]) {
    const done = untilCompleted(adapter, s.id);
    await adapter.sendMessage(s.id, q);
    await done;
  }
  assert.deepEqual(calls[1].body.input, [{ role: "user", content: "one" }, { role: "assistant", content: "A" }, { role: "user", content: "two" }]);
});

test("history sent to the API is capped at maxHistoryMessages", async () => {
  const { adapter, calls } = setup(() => textResponse(okStream(["A"])), { maxHistoryMessages: 2 });
  const s = await adapter.createSession();
  for (const q of ["one", "two", "three"]) {
    const done = untilCompleted(adapter, s.id);
    await adapter.sendMessage(s.id, q);
    await done;
  }
  assert.equal(calls[2].body.input.length, 2);
  assert.deepEqual(calls[2].body.input.at(-1), { role: "user", content: "three" });
});

test("insufficient_quota -> usage_limit (not retryable); the unsent user message is rolled back", async () => {
  const { adapter, store } = setup(() => jsonResponse(429, { error: { code: "insufficient_quota", message: "quota" } }));
  const s = await adapter.createSession();
  await assert.rejects(adapter.sendMessage(s.id, "hi"), (e: unknown) => e instanceof AgentError && e.kind === "usage_limit" && !e.retryable);
  assert.equal(store.messages(s.id).length, 0);
  // 失敗後も再送できる(進行中のまま残らない)
  await assert.rejects(adapter.sendMessage(s.id, "again"), (e: unknown) => e instanceof AgentError && e.kind === "usage_limit");
});

test("401 -> unavailable and not retryable; 429 rate limit and 5xx -> retryable", async () => {
  for (const [status, retryable] of [[401, false], [429, true], [503, true]] as const) {
    const { adapter } = setup(() => jsonResponse(status, { error: { message: "x" } }));
    const s = await adapter.createSession();
    await assert.rejects(adapter.sendMessage(s.id, "hi"), (e: unknown) => e instanceof AgentError && e.kind === "unavailable" && e.retryable === retryable);
  }
});

test("interrupt aborts the stream, keeps the partial answer, and reports interrupted", async () => {
  const { adapter, store } = setup((_c, init) => new Response(new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(sse([{ type: "response.output_text.delta", delta: "途中" }])));
      init.signal!.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
    },
  })));
  const s = await adapter.createSession();
  const done = untilCompleted(adapter, s.id);
  await adapter.sendMessage(s.id, "長い話をして");
  await new Promise((r) => setTimeout(r, 20));
  await adapter.interrupt(s.id);
  const last = (await done).at(-1) as Extract<AgentEvent, { type: "turn.completed" }>;
  assert.equal(last.status, "interrupted");
  assert.deepEqual(store.messages(s.id).map((m) => m.text), ["長い話をして", "途中"]);
});

test("a second message while streaming is busy", async () => {
  const { adapter } = setup((_c, init) => new Response(new ReadableStream({
    start(c) { init.signal!.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError"))); },
  })));
  const s = await adapter.createSession();
  const done = untilCompleted(adapter, s.id);
  await adapter.sendMessage(s.id, "one");
  await assert.rejects(adapter.sendMessage(s.id, "two"), (e: unknown) => e instanceof AgentError && e.kind === "busy");
  await adapter.interrupt(s.id);
  await done;
});

test("web search tool is only sent when enabled", async () => {
  for (const [opts, expected] of [[{}, undefined], [{ webSearch: true }, [{ type: "web_search" }]]] as const) {
    const { adapter, calls } = setup(() => textResponse(okStream(["A"])), opts);
    const s = await adapter.createSession();
    const done = untilCompleted(adapter, s.id);
    await adapter.sendMessage(s.id, "天気は？");
    await done;
    assert.deepEqual(calls[0].body.tools, expected);
  }
});

test("unknown session -> not_found; history reads from the store", async () => {
  const { adapter } = setup(() => textResponse(okStream(["A"])));
  await assert.rejects(adapter.sendMessage("nope", "hi"), (e: unknown) => e instanceof AgentError && e.kind === "not_found");
  const s = await adapter.createSession();
  const done = untilCompleted(adapter, s.id);
  await adapter.sendMessage(s.id, "q");
  await done;
  assert.deepEqual((await adapter.readHistory(s.id)).map((h) => [h.kind, h.text]), [["user", "q"], ["agent", "A"]]);
});
