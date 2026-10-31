import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry, AgentError, CodexAdapter, type AgentEvent } from "../src/index.ts";

const FAKE = new URL("./fake-app-server.mjs", import.meta.url).pathname;

function setup(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "vag-test-"));
  const logFile = join(dir, "calls.log");
  process.env.FAKE_MODE = mode;
  process.env.FAKE_LOG = logFile;
  const adapter = new CodexAdapter({ command: [process.execPath, FAKE], turnTimeoutMs: 5000 });
  const calls = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean) : []);
  return { adapter, calls };
}

function untilCompleted(adapter: CodexAdapter, sessionId: string): Promise<AgentEvent[]> {
  return new Promise((resolve) => {
    const events: AgentEvent[] = [];
    const off = adapter.subscribe(sessionId, (e) => {
      events.push(e);
      if (e.type === "turn.completed") { off(); resolve(events); }
    });
  });
}

test("listSessions / getSession map Codex threads", async () => {
  const { adapter } = setup("ok");
  const [s] = await adapter.listSessions();
  assert.equal(s.id, "t1");
  assert.equal(s.agentId, "codex");
  assert.equal(s.title, "vag-probe-test");
  assert.equal(s.updatedAt, "2025-10-30T04:53:20.000Z");
  assert.equal((await adapter.getSession("t1")).id, "t1");
});

test("readHistory follows cursors, keeps API order, and needs no write lease", async () => {
  const { adapter, calls } = setup("ok");
  const items = await adapter.readHistory("t1");
  assert.deepEqual(items.map((i) => [i.id, i.kind, i.text]), [["i1", "user", "q"], ["i0", "command", undefined], ["i2", "agent", "a"]]);
  assert.ok(!calls().includes("thread/resume"));
});

test("sendMessage: events stream, turn completes ok, lease is released before the final event", async () => {
  const { adapter, calls } = setup("ok");
  const done = untilCompleted(adapter, "t1");
  await adapter.sendMessage("t1", "hello");
  assert.equal(adapter.activeLeaseCount, 1);
  const events = await done;
  assert.deepEqual(events.map((e) => e.type), ["turn.started", "message.delta", "message.delta", "message.completed", "turn.completed"]);
  const last = events.at(-1) as Extract<AgentEvent, { type: "turn.completed" }>;
  assert.equal(last.status, "ok");
  assert.equal(adapter.activeLeaseCount, 0);
  assert.deepEqual(calls().filter((c) => /resume|turn\/start/.test(c)), ["thread/resume", "turn/start"]);
});

test("busy: another writer holds the thread -> AgentError(busy), nothing is sent", async () => {
  const { adapter, calls } = setup("busy");
  await assert.rejects(adapter.sendMessage("t1", "hello"), (e: unknown) => e instanceof AgentError && e.kind === "busy" && e.retryable);
  assert.ok(!calls().includes("turn/start"));
  assert.equal(adapter.activeLeaseCount, 0);
});

test("usage limit: turn/completed after an error notification is reported as error, not ok", async () => {
  const { adapter } = setup("usage_limit");
  const done = untilCompleted(adapter, "t1");
  await adapter.sendMessage("t1", "hello");
  const events = await done;
  const last = events.at(-1) as Extract<AgentEvent, { type: "turn.completed" }>;
  assert.equal(last.status, "error");
  assert.equal(last.error?.kind, "usage_limit");
  assert.equal(last.error?.retryable, false);
  assert.equal(adapter.activeLeaseCount, 0);
});

test("server-initiated requests (approvals) are rejected fail-closed and surfaced", async () => {
  const { adapter, calls } = setup("approval");
  const done = untilCompleted(adapter, "t1");
  await adapter.sendMessage("t1", "hello");
  const events = await done;
  assert.ok(events.some((e) => e.type === "request.unhandled"));
  assert.ok(calls().includes("response:error"));
});

test("a second send to the same thread while leased is busy", async () => {
  const { adapter } = setup("ok");
  const done = untilCompleted(adapter, "t1");
  await adapter.sendMessage("t1", "one");
  await assert.rejects(adapter.sendMessage("t1", "two"), (e: unknown) => e instanceof AgentError && e.kind === "busy");
  await done;
  await adapter.sendMessage("t1", "three"); // 解放後は送れる
  await untilCompleted(adapter, "t1");
});

test("interrupt is unsupported until its API is verified; capabilities do not claim it", async () => {
  const { adapter } = setup("ok");
  assert.ok(!adapter.capabilities.has("interrupt"));
  await assert.rejects(adapter.interrupt("t1"), (e: unknown) => e instanceof AgentError && e.kind === "unsupported");
});

test("app-server that cannot start -> unavailable", async () => {
  const adapter = new CodexAdapter({ command: ["/nonexistent/codex-binary", "app-server"] });
  await assert.rejects(adapter.listSessions(), (e: unknown) => e instanceof AgentError && e.kind === "unavailable");
});

test("registry rejects duplicates", () => {
  const r = new AdapterRegistry();
  const a = new CodexAdapter();
  r.register(a);
  assert.throws(() => r.register(new CodexAdapter()));
  assert.equal(r.get("codex"), a);
});
