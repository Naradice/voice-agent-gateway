import { test } from "node:test";
import assert from "node:assert/strict";
import { Gateway, isNoticeRequest } from "../src/gateway.ts";
import { CompletionWatcher } from "../src/watch.ts";
import { Store } from "../src/store.ts";
import { ofType, setup, speeches } from "./helpers.ts";

test("isNoticeRequest recognizes asking for waiting messages, not ordinary chat", () => {
  for (const t of ["待機メッセージを読んで", "待機中の通知を教えて", "未読の通知は", "新着の通知を読んで", "通知を読んで"]) assert.ok(isNoticeRequest(t), t);
  for (const t of ["今日の天気は", "Codexの状況を教えて", "メッセージを送って"]) assert.ok(!isNoticeRequest(t), t);
});

test("notify keeps a notice without speaking it, and tells connected devices the count", () => {
  const { gw, out } = setup();
  gw.notify({ kind: "turn_settled", text: "Codexの「JEPA」で作業が一区切りしました。", destination: "codex" });
  assert.deepEqual(speeches(out), [], "自動では読み上げない");
  assert.deepEqual(ofType(out, "notices"), [{ type: "notices", count: 1, latest: "Codexの「JEPA」で作業が一区切りしました。" }]);
});

test("a device that connects later is told the pending count", () => {
  const store = new Store();
  const { gw } = setup({ store });
  gw.notify({ kind: "k", text: "A" });
  const out2: any[] = [];
  gw.attach("dev2", { send: (m) => { out2.push(m); } });
  assert.equal(out2[0].type, "hello.ok");
  assert.deepEqual(out2.at(-1), { type: "notices", count: 1, latest: "A" });
});

test("asking for waiting messages reads them in order, marks them read, and resets the count", async () => {
  const { gw, out, chat } = setup();
  gw.notify({ kind: "k", text: "一つ目。" });
  gw.notify({ kind: "k", text: "二つ目。" });
  out.length = 0;
  await gw.handle("dev1", { type: "message.send", requestId: "r1", text: "待機メッセージを読んで" });
  const sp = speeches(out);
  assert.equal(sp.length, 1);
  assert.match(sp[0].text, /2件あります.*1件目。一つ目。.*2件目。二つ目。/);
  assert.ok(sp[0].eventId, "保存される(切断中でも後で読める)");
  assert.deepEqual(ofType(out, "notices").at(-1), { type: "notices", count: 0 });
  assert.equal(ofType(out, "request.accepted")[0].intent, "read_notices");
  assert.deepEqual(chat.sent, [], "Agent には送らない");

  out.length = 0;
  await gw.handle("dev1", { type: "message.send", requestId: "r2", text: "待機メッセージを読んで" });
  assert.equal(speeches(out)[0].text, "待機メッセージはありません。");
});

test("at most 8 notices are read at once; the rest stay pending", async () => {
  const { gw, out } = setup();
  for (let i = 1; i <= 10; i++) gw.notify({ kind: "k", text: `通知${i}。` });
  out.length = 0;
  await gw.handle("dev1", { type: "message.send", requestId: "r1", text: "待機メッセージを読んで" });
  assert.match(speeches(out)[0].text, /10件あります.*残り2件/);
  assert.equal((ofType(out, "notices").at(-1) as any).count, 2);
});

test("old and excess notices are discarded", () => {
  const store = new Store();
  for (let i = 0; i < 60; i++) store.addNotice({ kind: "k", text: String(i) });
  store.pruneNotices(new Date(Date.now() - 1000).toISOString(), 50);
  const left = store.pendingNotices();
  assert.equal(left.length, 50);
  assert.equal(left[0].text, "10", "古いものから捨てる");
  store.pruneNotices(new Date(Date.now() + 1000).toISOString(), 50);
  assert.equal(store.pendingNotices().length, 0, "期限切れ");
});

// ---- 検知 ----

function watcherSetup() {
  let sessions = [{ id: "x1", agentId: "codex", title: "JEPA", updatedAt: "t1" }, { id: "x2", agentId: "codex", title: "別件", updatedAt: "t1" }];
  const settled: string[] = [];
  const w = new CompletionWatcher({ adapter: { listSessions: async () => sessions as any }, onSettled: (s) => settled.push(s.id) });
  return { w, settled, set: (u: Record<string, string>) => { sessions = sessions.map((s) => ({ ...s, updatedAt: u[s.id] ?? s.updatedAt })); } };
}

test("watcher: the first poll only records a baseline", async () => {
  const { w, settled } = watcherSetup();
  await w.poll(); await w.poll();
  assert.deepEqual(settled, []);
});

test("watcher: notifies once after updates stop, not while they continue", async () => {
  const { w, settled, set } = watcherSetup();
  await w.poll();
  set({ x1: "t2" }); await w.poll();
  assert.deepEqual(settled, [], "更新直後はまだ動いているかもしれない");
  set({ x1: "t3" }); await w.poll();
  assert.deepEqual(settled, [], "更新が続いている");
  await w.poll();
  assert.deepEqual(settled, ["x1"]);
  await w.poll(); await w.poll();
  assert.deepEqual(settled, ["x1"], "同じ更新を二度通知しない");
});

test("watcher: updates caused by this gateway's own send are not notified", async () => {
  const { w, settled, set } = watcherSetup();
  await w.poll();
  w.noteOwn("x1");
  set({ x1: "t2" }); await w.poll(); await w.poll();
  assert.deepEqual(settled, []);
  set({ x1: "t3" }); await w.poll(); await w.poll();
  assert.deepEqual(settled, ["x1"], "その後の別の更新は通知する");
});

test("watcher: a new thread that appears later is treated as activity; failures do not stop polling", async () => {
  let fail = false;
  let sessions: any[] = [{ id: "a", title: "A", updatedAt: "t1" }];
  const settled: string[] = [];
  const w = new CompletionWatcher({ adapter: { listSessions: async () => { if (fail) throw new Error("down"); return sessions; } }, onSettled: (s) => settled.push(s.id) });
  await w.poll();
  fail = true; await w.poll();
  fail = false;
  sessions = [...sessions, { id: "b", title: "B", updatedAt: "t1" }];
  await w.poll(); await w.poll();
  assert.deepEqual(settled, ["b"]);
});
