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
  assert.deepEqual(calls[0].body.messages, [{ role: "system", content: "be brief\n\n/no_think" }, { role: "user", content: "やあ" }]);
  assert.equal(calls[0].body.stream, true);
  assert.equal(calls[0].body.reasoning_effort, "none");
  assert.deepEqual(store.messages(s.id).map((m) => m.text), ["やあ", "こんにちは"]);
  assert.deepEqual(store.usageTotals(), { inputTokens: 20, outputTokens: 4, requests: 1 });
  assert.equal((await adapter.listSessions())[0].agentId, "chat");
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

test("<think> blocks are never emitted or stored, even when the tags are split across chunks", async () => {
  const parts = ["<thi", "nk>\nまず考え", "る</th", "ink>\n\nこんにちは", "、元気です"];
  const { adapter, store } = setup(() => streamOf(chunks(parts)));
  const s = await adapter.createSession();
  const done = untilCompleted(adapter, s.id);
  await adapter.sendMessage(s.id, "やあ");
  const events = await done;
  const spoken = events.filter((e) => e.type === "message.delta").map((e: any) => e.text).join("");
  assert.equal(spoken, "こんにちは、元気です");
  assert.deepEqual(store.messages(s.id).map((m) => m.text), ["やあ", "こんにちは、元気です"]);
});

test("reasoning in a separate field is ignored; /no_think can be turned off", async () => {
  const text = `data: ${JSON.stringify({ choices: [{ delta: { reasoning: "ひみつの思考" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: "答え" } }] })}\n\n`;
  const { adapter, calls } = setup(() => streamOf(text), { suppressThinking: false });
  const s = await adapter.createSession();
  const done = untilCompleted(adapter, s.id);
  await adapter.sendMessage(s.id, "q");
  const events = await done;
  assert.equal(events.filter((e) => e.type === "message.delta").map((e: any) => e.text).join(""), "答え");
  assert.ok(!calls[0].body.messages[0].content.includes("/no_think"));
  assert.equal(calls[0].body.reasoning_effort, undefined);
});

test("extraBody can override the thinking setting", async () => {
  const { adapter, calls } = setup(() => streamOf(chunks(["A"])), { extraBody: { reasoning_effort: "low" } });
  const s = await adapter.createSession();
  const done = untilCompleted(adapter, s.id);
  await adapter.sendMessage(s.id, "q");
  await done;
  assert.equal(calls[0].body.reasoning_effort, "low");
});

test("grounding context goes into the system message for this turn only and is not stored", async () => {
  const { adapter, store, calls } = setup(() => streamOf(chunks(["A"])), { grounding: async (t: string) => (t.includes("天気") ? "CTX-天気" : undefined) });
  const s = await adapter.createSession();
  for (const q of ["天気は？", "こんにちは"]) {
    const done = untilCompleted(adapter, s.id);
    await adapter.sendMessage(s.id, q);
    await done;
  }
  assert.ok(calls[0].body.messages[0].content.includes("CTX-天気"));
  assert.ok(!calls[1].body.messages[0].content.includes("CTX-天気"));
  assert.ok(!store.messages(s.id).some((m) => m.text.includes("CTX")));
});

test("a throwing grounding function does not break the conversation", async () => {
  const { adapter } = setup(() => streamOf(chunks(["A"])), { grounding: async () => { throw new Error("boom"); } });
  const s = await adapter.createSession();
  const done = untilCompleted(adapter, s.id);
  await adapter.sendMessage(s.id, "天気は？");
  assert.equal(((await done).at(-1) as any).status, "ok");
});

test("warns when the prompt nearly fills the configured context (silent truncation guard)", async () => {
  const usage = `data: ${JSON.stringify({ choices: [{ delta: { content: "A" } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 4079, completion_tokens: 3 } })}\n\n`;
  const { adapter } = setup(() => streamOf(usage), { contextTokens: 4096 });
  const s = await adapter.createSession();
  const done = untilCompleted(adapter, s.id);
  await adapter.sendMessage(s.id, "q");
  const w = (await done).find((e) => e.type === "warning") as Extract<AgentEvent, { type: "warning" }> | undefined;
  assert.equal(w?.code, "context_nearly_full");

  const quiet = setup(() => streamOf(chunks(["A"])), { contextTokens: 4096 }); // 20トークン: 警告なし
  const s2 = await quiet.adapter.createSession();
  const done2 = untilCompleted(quiet.adapter, s2.id);
  await quiet.adapter.sendMessage(s2.id, "q");
  assert.ok(!(await done2).some((e) => e.type === "warning"));
});

test("extraBody max_tokens is sent so that replies stay short on slow CPUs", async () => {
  const { adapter, calls } = setup(() => streamOf(chunks(["A"])), { extraBody: { max_tokens: 300 } });
  const s = await adapter.createSession();
  const done = untilCompleted(adapter, s.id);
  await adapter.sendMessage(s.id, "q");
  await done;
  assert.equal(calls[0].body.max_tokens, 300);
  assert.equal(calls[0].body.reasoning_effort, "none", "思考を止める既定は維持される");
});
