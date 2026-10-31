import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentError, LocalLLMAdapter, Store, type AgentEvent } from "../src/index.ts";

const enc = new TextEncoder();
const chunks = (parts: string[], usage = true) => [
  ...parts.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`),
  ...(usage ? [`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 4 } })}\n\n`] : []),
  "data: [DONE]\n\n",
].join("");
const streamOf = (text: string) => new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(text)); c.close(); } }), { status: 200 });

function setup(handler: (body: any, init: RequestInit) => Response | Promise<Response>, extra: object = {}) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const store = new Store();
  const adapter = new LocalLLMAdapter({
    store, model: "llama-test", instructions: "be brief", ...extra,
    fetch: (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, headers: init.headers as Record<string, string>, body });
      return handler(body, init);
    }) as typeof fetch,
  });
  return { adapter, store, calls };
}

const untilCompleted = (adapter: LocalLLMAdapter, sessionId: string) =>
  new Promise<AgentEvent[]>((resolve) => {
    const events: AgentEvent[] = [];
    const off = adapter.subscribe(sessionId, (e: AgentEvent) => { events.push(e); if (e.type === "turn.completed") { off(); resolve(events); } });
  });

test("streams chat-completions deltas to Ollama's default endpoint, with no auth header", async () => {
  const { adapter, store, calls } = setup(() => streamOf(chunks(["こん", "にちは"])));
  const s = await adapter.createSession();
  const done = untilCompleted(adapter, s.id);
  await adapter.sendMessage(s.id, "やあ");
  const events = await done;

  assert.deepEqual(events.map((e) => e.type), ["turn.started", "message.delta", "message.delta", "message.completed", "turn.completed"]);
  assert.equal(calls[0].url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(calls[0].headers.authorization, undefined);
  assert.deepEqual(calls[0].body.messages, [{ role: "system", content: "be brief" }, { role: "user", content: "やあ" }]);
  assert.equal(calls[0].body.stream, true);
  assert.deepEqual(store.messages(s.id).map((m) => m.text), ["やあ", "こんにちは"]);
  assert.deepEqual(store.usageTotals(), { inputTokens: 20, outputTokens: 4, requests: 1 });
  assert.equal(s.id && (await adapter.listSessions())[0].agentId, "local");
});

test("old history is dropped by the character budget, but the latest message is always kept", async () => {
  const { adapter, calls } = setup(() => streamOf(chunks(["A"])), { maxHistoryChars: 12 });
  const s = await adapter.createSession();
  for (const q of ["1234567890", "abcdefghij", "これは最新の長い発話です。これは最新の長い発話です。"]) {
    const done = untilCompleted(adapter, s.id);
    await adapter.sendMessage(s.id, q);
    await done;
  }
  const last = calls[2].body.messages.filter((m: any) => m.role !== "system");
  assert.deepEqual(last.map((m: any) => m.content), ["これは最新の長い発話です。これは最新の長い発話です。"]);
});

test("connection refused -> retryable unavailable with a hint; the user message is rolled back", async () => {
  const { adapter, store } = setup(() => { throw new TypeError("fetch failed"); });
  const s = await adapter.createSession();
  await assert.rejects(adapter.sendMessage(s.id, "hi"), (e: unknown) => e instanceof AgentError && e.kind === "unavailable" && e.retryable && /起動/.test(e.message));
  assert.equal(store.messages(s.id).length, 0);
});

test("unknown model (404) -> not_found, not retryable", async () => {
  const { adapter } = setup(() => new Response(JSON.stringify({ error: { message: "model 'x' not found" } }), { status: 404 }));
  const s = await adapter.createSession();
  await assert.rejects(adapter.sendMessage(s.id, "hi"), (e: unknown) => e instanceof AgentError && e.kind === "not_found" && !e.retryable);
});

test("an error event in the middle of the stream ends the turn as error but keeps the partial text", async () => {
  const text = `data: ${JSON.stringify({ choices: [{ delta: { content: "途中" } }] })}\n\ndata: ${JSON.stringify({ error: { message: "out of memory" } })}\n\n`;
  const { adapter, store } = setup(() => streamOf(text));
  const s = await adapter.createSession();
  const done = untilCompleted(adapter, s.id);
  await adapter.sendMessage(s.id, "hi");
  const last = (await done).at(-1) as Extract<AgentEvent, { type: "turn.completed" }>;
  assert.equal(last.status, "error");
  assert.deepEqual(store.messages(s.id).map((m) => m.text), ["hi", "途中"]);
});

test("interrupt aborts a slow local generation", async () => {
  const { adapter } = setup((_b, init) => new Response(new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "長" } }] })}\n\n`));
      init.signal!.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
    },
  })));
  const s = await adapter.createSession();
  const done = untilCompleted(adapter, s.id);
  await adapter.sendMessage(s.id, "hi");
  await new Promise((r) => setTimeout(r, 20));
  await adapter.interrupt(s.id);
  assert.equal(((await done).at(-1) as any).status, "interrupted");
});
