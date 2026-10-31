// テスト用の偽 codex app-server。Phase 0A で観測した挙動(メソッド名・エラー文言)を再現する。
// FAKE_MODE: ok | busy | usage_limit | approval     FAKE_LOG: 受信したメソッドを追記するファイル
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const mode = process.env.FAKE_MODE ?? "ok";
const log = process.env.FAKE_LOG;
const rec = (s) => log && appendFileSync(log, s + "\n");
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
const notify = (method, params = {}) => send({ method, params });
const thread = { id: "t1", name: "vag-probe-test", preview: "hello", updatedAt: 1761800000, status: { type: "notLoaded" } };

const complete = () => notify("turn/completed", { turn: { id: "turn2" } });

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined) {
    // サーバー発リクエスト(承認要求)への応答
    rec(`response:${m.error ? "error" : "result"}`);
    if (m.id === 900) complete();
    return;
  }
  rec(m.method);
  const reply = (result) => send({ id: m.id, result });
  const fail = (code, message) => send({ id: m.id, error: { code, message } });
  switch (m.method) {
    case "initialize": return reply({ userAgent: "fake" });
    case "thread/list": return reply({ data: [thread], nextCursor: null });
    case "thread/read": return reply({ thread: { ...thread, turns: [] } });
    case "thread/turns/list": return reply({ data: [{ id: "turn1" }], nextCursor: null });
    case "thread/items/list":
      return m.params.cursor
        ? reply({ data: [{ turnId: "turn1", item: { type: "agentMessage", id: "i2", text: "a" } }], nextCursor: null })
        : reply({ data: [{ turnId: "turn1", item: { type: "userMessage", id: "i1", content: [{ type: "text", text: "q" }] } }, { turnId: "turn1", item: { type: "commandExecution", id: "i0" } }], nextCursor: "c1" });
    case "thread/resume":
      return mode === "busy" ? fail(-32600, "thread t1 already has an active writer") : reply({ thread: { ...thread, status: { type: "idle" } } });
    case "turn/start":
      reply({ turn: { id: "turn2" } });
      setTimeout(() => {
        notify("turn/started");
        if (mode === "usage_limit") {
          notify("error", { message: "You've hit your usage limit. try again later" });
          return complete();
        }
        if (mode === "approval") return send({ id: 900, method: "item/commandExecution/requestApproval", params: {} });
        notify("item/agentMessage/delta", { delta: "O" });
        notify("item/agentMessage/delta", { delta: "K" });
        notify("item/completed", { item: { type: "agentMessage", id: "i3", text: "OK" } });
        complete();
      }, 10);
      return;
    default:
      return fail(-32601, `unknown method ${m.method}`);
  }
});
