import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentError } from "../src/adapter.ts";
import { Gateway } from "../src/gateway.ts";
import { Store } from "../src/store.ts";
import { StubRouter, ofType, session, setup, speeches } from "./helpers.ts";

const send = (gw: Gateway, requestId: string, text: string, sessionId?: string) =>
  gw.handle("dev1", { type: "message.send", requestId, text, sessionId });

test("chat answers are spoken sentence by sentence while streaming, with increasing event ids", async () => {
  const { gw, chat, out } = setup();
  await send(gw, "r1", "やあ");
  assert.equal(ofType(out, "request.accepted").length, 1);
  assert.deepEqual(chat.sent, [{ sessionId: "c1", text: "やあ" }]);

  chat.emit({ type: "turn.started", sessionId: "c1" });
  chat.emit({ type: "message.delta", sessionId: "c1", text: "こんにちは。" });
  chat.emit({ type: "message.delta", sessionId: "c1", text: " 元気" });
  chat.emit({ type: "message.delta", sessionId: "c1", text: "です。" });
  chat.emit({ type: "message.completed", sessionId: "c1", text: "こんにちは。 元気です。", phase: "final_answer" });
  chat.emit({ type: "turn.completed", sessionId: "c1", status: "ok" });

  const sp = speeches(out);
  assert.deepEqual(sp.map((s) => s.text), ["こんにちは。", "元気です。"]);
  assert.ok(sp.every((s) => s.priority === "normal" && s.destination === "chat"));
  assert.deepEqual(sp.map((s) => s.eventId), ["1", "2"]);
});

test("a new conversation is created when the router says create", async () => {
  const router = new StubRouter({ destination: "chat", action: "create", reason: "stub" });
  const { gw, chat, out } = setup({ router });
  await send(gw, "r1", "別の話");
  const acc = ofType(out, "request.accepted")[0];
  assert.equal(acc.created, true);
  assert.equal(acc.sessionId, "chat-new-2");
  assert.equal(chat.sent[0].sessionId, "chat-new-2");
});

test("events produced while disconnected are replayed after reconnect; acked ones are not", async () => {
  const { gw, chat, out, link } = setup();
  await send(gw, "r1", "やあ");
  chat.emit({ type: "message.delta", sessionId: "c1", text: "一つ目。" });
  assert.equal(speeches(out).length, 1);

  gw.detach("dev1", link);
  chat.emit({ type: "message.delta", sessionId: "c1", text: "二つ目。三つ目。" });
  assert.equal(speeches(out).length, 1, "切断中は届かない");

  const out2: any[] = [];
  const replayed = gw.attach("dev1", { send: (m) => { out2.push(m); } }, "1"); // 1番までは処理済み
  assert.equal(replayed, 2);
  assert.deepEqual(out2.map((m) => m.type), ["hello.ok", "speech.enqueue", "speech.enqueue"]);
  assert.deepEqual(out2.slice(1).map((m) => [m.eventId, m.text]), [["2", "二つ目。"], ["3", "三つ目。"]]);

  await gw.handle("dev1", { type: "ack", eventId: "3" });
  const out3: any[] = [];
  assert.equal(gw.attach("dev1", { send: (m) => { out3.push(m); } }), 0);
});

test("a duplicate requestId is not dispatched twice; the earlier result is returned again", async () => {
  const { gw, chat, out } = setup();
  await send(gw, "r1", "やあ");
  await send(gw, "r1", "やあ");
  assert.equal(chat.sent.length, 1);
  assert.equal(ofType(out, "request.accepted").length, 2);
  assert.deepEqual(ofType(out, "request.accepted")[0], ofType(out, "request.accepted")[1]);
});

test("ambiguous routing asks for confirmation, then dispatches the chosen candidate", async () => {
  const router = new StubRouter({
    destination: "codex", action: "confirm", reason: "same topic across agents",
    candidates: [{ destination: "chat", sessionId: "c1" }, { destination: "codex", sessionId: "x1" }],
  });
  const { gw, codex, chat, out } = setup({ router });
  await send(gw, "r1", "JEPAの実験の件");
  const ask = ofType(out, "routing.confirmation_required")[0];
  assert.equal(ask.candidates.length, 2);
  assert.match(ask.prompt, /1番、チャットの「雑談」。2番、Codexの「JEPA実験」/);
  assert.equal(codex.sent.length + chat.sent.length, 0, "確認前には送らない");

  await gw.handle("dev1", { type: "routing.confirm", requestId: "r1", choice: 1 });
  assert.deepEqual(codex.sent, [{ sessionId: "x1", text: "JEPAの実験の件" }]);
  assert.equal(ofType(out, "request.accepted").at(-1)?.destination, "codex");
});

test("confirmation can be cancelled; confirming an unknown request is invalid", async () => {
  const router = new StubRouter({ destination: "codex", action: "confirm", reason: "x", candidates: [{ destination: "codex", sessionId: "x1" }] });
  const { gw, codex, out } = setup({ router });
  await send(gw, "r1", "リポジトリを削除して");
  assert.match(ofType(out, "routing.confirmation_required")[0].prompt, /送ってよいですか/);
  await gw.handle("dev1", { type: "routing.confirm", requestId: "r1", choice: "cancel" });
  assert.equal(ofType(out, "request.rejected").at(-1)?.code, "cancelled");
  await gw.handle("dev1", { type: "routing.confirm", requestId: "r1", choice: 0 });
  assert.equal(ofType(out, "request.rejected").at(-1)?.code, "invalid");
  await gw.handle("dev1", { type: "routing.confirm", requestId: "nope", choice: 0 });
  assert.equal(ofType(out, "request.rejected").at(-1)?.code, "invalid");
  assert.equal(codex.sent.length, 0);
});

test("a confirmation with no candidates is rejected as ambiguous", async () => {
  const { gw, out } = setup({ router: new StubRouter({ destination: "chat", action: "confirm", reason: "vague", candidates: [] }) });
  await send(gw, "r1", "あれどうなった");
  assert.equal(ofType(out, "request.rejected")[0].code, "ambiguous");
});

test("busy and usage_limit errors become spoken-ready rejections with the right retry flag", async () => {
  const router = new StubRouter({ destination: "codex", sessionId: "x1", action: "resume", reason: "stub" });
  const { gw, codex, out } = setup({ router });
  codex.failNext = new AgentError("busy", "x");
  await send(gw, "r1", "続けて");
  const busy = ofType(out, "request.rejected")[0];
  assert.deepEqual([busy.code, busy.retryable], ["busy", true]);
  assert.match(busy.message, /別のアプリ/);

  codex.failNext = new AgentError("usage_limit", "x", { retryable: false });
  await send(gw, "r2", "続けて");
  const lim = ofType(out, "request.rejected")[1];
  assert.deepEqual([lim.code, lim.retryable], ["usage_limit", false]);

  await send(gw, "r1", "続けて"); // 失敗結果も重複排除され、再実行されない
  assert.equal(ofType(out, "request.rejected").length, 3);
  assert.equal(codex.sent.length, 0);
});

test("interrupt by voice and by message; targets without the capability are refused", async () => {
  const router = new StubRouter({ destination: "chat", sessionId: "c1", action: "resume", intent: "interrupt", reason: "kw" });
  const { gw, chat, codex, out } = setup({ router });
  await send(gw, "r1", "止めて");
  assert.deepEqual(chat.interrupted, ["c1"]);
  assert.equal(ofType(out, "request.accepted")[0].intent, "interrupt");

  await gw.handle("dev1", { type: "interrupt", requestId: "r2", sessionId: "x1" }); // Codex は未対応
  assert.equal(ofType(out, "request.rejected")[0].code, "unsupported");
  assert.deepEqual(codex.interrupted, []);

  await gw.handle("dev1", { type: "interrupt", requestId: "r3", sessionId: "c1" });
  assert.deepEqual(chat.interrupted, ["c1", "c1"]);

  const refused = new StubRouter({ destination: "codex", sessionId: "x1", action: "confirm", intent: "interrupt", reason: "interrupt unsupported by target", candidates: [] });
  const s2 = setup({ router: refused });
  await send(s2.gw, "r1", "止めて");
  assert.equal(ofType(s2.out, "request.rejected")[0].code, "unsupported");
});

test("read_latest speaks the last agent message, formatted", async () => {
  const router = new StubRouter({ destination: "codex", sessionId: "x1", action: "resume", intent: "read_latest", reason: "kw" });
  const { gw, codex, out } = setup({ router });
  codex.history.x1 = [
    { id: "1", turnId: "t", kind: "user", text: "確認して" },
    { id: "2", turnId: "t", kind: "agent", text: "**完了**しました。詳細は https://example.com を見てください。" },
    { id: "3", turnId: "t", kind: "command" },
  ];
  await send(gw, "r1", "Codexの返事を読んで");
  assert.equal(speeches(out)[0].text, "完了しました。詳細は リンク を見てください。");
  assert.equal(codex.sent.length, 0, "読み上げは送信ではない");
});

test("a request interrupted by a restart is reported as indeterminate and never re-run", async () => {
  const store = new Store();
  store.putRequest("dev1", "r9", "dispatching", { decision: {} }); // 前回の実行中にクラッシュした想定
  const { gw, chat, codex, out } = setup({ store });
  await send(gw, "r9", "やあ");
  const r = ofType(out, "request.rejected")[0];
  assert.deepEqual([r.code, r.retryable], ["indeterminate", false]);
  assert.equal(chat.sent.length + codex.sent.length, 0);
});

test("code blocks are never read aloud while streaming", async () => {
  const { gw, chat, out } = setup();
  await send(gw, "r1", "書いて");
  for (const d of ["実装です。``", "`ts\nconst a = 1;\n``", "`\n以上です。"]) chat.emit({ type: "message.delta", sessionId: "c1", text: d });
  chat.emit({ type: "message.completed", sessionId: "c1", text: "…", phase: "final_answer" });
  assert.deepEqual(speeches(out).map((s) => s.text), ["実装です。", "コードは省略します。", "以上です。"]);
});

test("Codex: commentary is not read; the final answer is spoken once at high priority", async () => {
  const router = new StubRouter({ destination: "codex", sessionId: "x1", action: "resume", reason: "stub" });
  const { gw, codex, out } = setup({ router });
  await send(gw, "r1", "実験を回して");
  codex.emit({ type: "message.delta", sessionId: "x1", text: "確認しています" });
  codex.emit({ type: "message.completed", sessionId: "x1", text: "ファイルを調べます", phase: "commentary" });
  codex.emit({ type: "message.completed", sessionId: "x1", text: "実験が完了しました。\n精度は0.9です。", phase: "final_answer" });
  codex.emit({ type: "turn.completed", sessionId: "x1", status: "ok" });
  const sp = speeches(out);
  assert.deepEqual(sp.map((s) => [s.text, s.priority]), [["実験が完了しました。精度は0.9です。", "high"]]);
});

test("failed turns are announced at critical priority; approval requests tell the user to check the PC", async () => {
  const router = new StubRouter({ destination: "codex", sessionId: "x1", action: "resume", reason: "stub" });
  const { gw, codex, out } = setup({ router });
  await send(gw, "r1", "実行して");
  codex.emit({ type: "request.unhandled", sessionId: "x1", method: "item/commandExecution/requestApproval" });
  codex.emit({ type: "turn.completed", sessionId: "x1", status: "error", error: new AgentError("usage_limit", "x", { retryable: false }) });
  assert.deepEqual(speeches(out).map((s) => [s.priority, s.text]), [
    ["critical", "確認を求められました。パソコンで確認してください。"],
    ["critical", "利用上限に達しているため、実行できません。"],
  ]);
});

test("model-loading notices are ephemeral: no event id and nothing stored for replay", async () => {
  const { gw, chat, out, store } = setup();
  await send(gw, "r1", "やあ");
  chat.emit({ type: "status", sessionId: "c1", code: "model_loading", message: "モデルを起動しています。少しお待ちください" });
  const s = speeches(out)[0];
  assert.equal(s.eventId, undefined);
  assert.equal(s.ephemeral, true);
  assert.deepEqual(store.eventsAfter("dev1", 0), []);
});

test("speech per turn is capped; the full text stays in history", async () => {
  const { gw, chat, out } = setup({ gateway: { maxSpeechChars: 10 } });
  await send(gw, "r1", "長く");
  chat.emit({ type: "message.delta", sessionId: "c1", text: "一二三四五六。七八九十。さらに続きます。もっと続きます。" });
  assert.deepEqual(speeches(out).map((s) => s.text), ["一二三四五六。", "以降は省略します。"]);
});

test("one adapter failing to list sessions does not block the others; the router sees the working ones", async () => {
  const router = new StubRouter({ destination: "chat", sessionId: "c1", action: "resume", reason: "stub" });
  const { gw, codex, out } = setup({ router });
  codex.listError = new Error("codex not installed");
  await send(gw, "r1", "やあ");
  assert.equal(ofType(out, "request.accepted").length, 1);
  assert.deepEqual(router.last!.ctx.sessions.map((s) => s.id), ["c1"]);
});

test("the router receives catalog sessions and the device's current session", async () => {
  const router = new StubRouter({ destination: "chat", sessionId: "c1", action: "resume", reason: "stub" });
  const { gw, out } = setup({ router });
  await send(gw, "r1", "やあ");
  await send(gw, "r2", "続き");
  assert.equal(router.last!.ctx.currentSessionId, "c1");
  const ids = router.last!.ctx.sessions.map((s) => s.id).sort();
  assert.deepEqual(ids, ["c1", "x1"]);
  assert.ok(router.last!.ctx.sessions.find((s) => s.id === "x1")!.keywords.includes("JEPA"));
  assert.equal(ofType(out, "request.accepted").length, 2);
});

test("ptt.start asks every adapter to prepare (model preloading) without replying", async () => {
  const { gw, chat, codex, out } = setup();
  await gw.handle("dev1", { type: "ptt.start" });
  assert.deepEqual([chat.prepared, codex.prepared], [1, 1]);
  assert.deepEqual(out, []);
});

test("hello.ok carries a stable instance id; an ack position from another instance is ignored and nothing is deleted", async () => {
  const { gw, chat, store } = setup();
  await send(gw, "r1", "やあ");
  chat.emit({ type: "message.delta", sessionId: "c1", text: "一つ目。二つ目。" });

  const first: any[] = [];
  gw.attach("dev1", { send: (m) => { first.push(m); } });
  const id = first[0].instanceId;
  assert.equal(id, store.instanceId());
  assert.equal(store.instanceId(), id, "同じ DB なら変わらない");

  const other: any[] = [];
  gw.attach("dev1", { send: (m) => { other.push(m); } }, "999", "another-gateway"); // 別の Gateway の位置
  assert.equal(other[0].replay, 2, "位置を無視して全件を再送する");
  assert.equal(store.eventsAfter("dev1", 0).length, 2, "削除されない");

  const same: any[] = [];
  gw.attach("dev1", { send: (m) => { same.push(m); } }, "999", id); // 同じ DB なら位置を信用する
  assert.equal(same[0].replay, 0);

  assert.notEqual(new Store().instanceId(), id, "別の DB は別の識別子");
});
