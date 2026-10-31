import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { tokenFingerprint } from "../src/connection.ts";
import { Gateway } from "../src/gateway.ts";
import { AdapterRegistry } from "../src/registry.ts";
import { startServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { FakeAdapter, StubRouter, session } from "./helpers.ts";

const TOKEN = "t".repeat(32);

async function boot(extra: { heartbeatMs?: number; helloTimeoutMs?: number; maxPayload?: number; log?: (level: "info" | "warn" | "error", msg: string, meta?: object) => void; diagnostics?: Record<string, unknown> } = {}) {
  const store = new Store();
  const chat = new FakeAdapter("chat", ["list_sessions", "read_history", "send_message", "subscribe", "interrupt", "create_session"], [session("c1", "chat", "雑談")]);
  const registry = new AdapterRegistry();
  registry.register(chat);
  const gateway = new Gateway({ store, registry, router: new StubRouter({ destination: "chat", sessionId: "c1", action: "resume", reason: "stub" }) });
  const server = await startServer({ gateway, devices: [{ deviceId: "pixel", token: TOKEN }, { deviceId: "other", token: "o".repeat(32) }], ...extra });
  return { server, chat, store };
}

// token: null はトークンなし(undefined だと既定値が使われてしまう)
function connect(port: number, token: string | null = TOKEN, opts: object = {}, path = "") {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, ...opts });
  const inbox: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); const w = waiters.shift(); w ? w(m) : inbox.push(m); });
  const next = (ms = 2000) => new Promise<any>((resolve, reject) => {
    if (inbox.length) return resolve(inbox.shift());
    const t = setTimeout(() => reject(new Error("timeout waiting for message")), ms);
    waiters.push((m) => { clearTimeout(t); resolve(m); });
  });
  const opened = new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); ws.once("unexpected-response", (_r, resp) => rej(new Error(`HTTP ${resp.statusCode}`))); });
  const closed = new Promise<number>((res) => ws.once("close", (code) => res(code)));
  const send = (m: object) => ws.send(JSON.stringify(m));
  return { ws, next, opened, closed, send };
}

test("connections without a valid bearer token are refused with 401", async () => {
  const { server } = await boot();
  for (const token of [null, "wrong-token", TOKEN.slice(1), TOKEN + "x"]) {
    await assert.rejects(connect(server.port, token).opened, /HTTP 401/);
  }
  await server.close();
});

test("hello, then a request round trip with speech events", async () => {
  const { server, chat } = await boot();
  const c = connect(server.port);
  await c.opened;
  c.send({ type: "hello" });
  assert.equal((await c.next()).type, "hello.ok");
  c.send({ type: "message.send", requestId: "r1", text: "やあ" });
  const acc = await c.next();
  assert.deepEqual([acc.type, acc.requestId, acc.destination], ["request.accepted", "r1", "chat"]);
  chat.emit({ type: "message.delta", sessionId: "c1", text: "こんにちは。" });
  const sp = await c.next();
  assert.deepEqual([sp.type, sp.text, sp.eventId], ["speech.enqueue", "こんにちは。", "1"]);
  c.ws.close();
  await server.close();
});

test("messages before hello are refused; bad input is reported without dropping the connection", async () => {
  const { server } = await boot();
  const c = connect(server.port);
  await c.opened;
  c.send({ type: "message.send", requestId: "r1", text: "x" });
  assert.equal((await c.next()).code, "not_ready");
  c.ws.send("not json");
  assert.equal((await c.next()).code, "invalid");
  c.send({ type: "hello" });
  assert.equal((await c.next()).type, "hello.ok");
  c.send({ type: "message.send", requestId: "r2", text: "" }); // 空の text
  assert.equal((await c.next()).code, "invalid");
  c.send({ type: "nope" });
  assert.equal((await c.next()).code, "invalid");
  c.ws.send(Buffer.from([1, 2, 3]));
  assert.equal((await c.next()).code, "invalid");
  c.ws.close();
  await server.close();
});

test("a client that never says hello is disconnected", async () => {
  const { server } = await boot({ helloTimeoutMs: 100 });
  const c = connect(server.port);
  await c.opened;
  assert.equal(await c.closed, 4001);
  await server.close();
});

test("reconnecting replays what was missed; a new connection replaces the old one", async () => {
  const { server, chat } = await boot();
  const a = connect(server.port);
  await a.opened;
  a.send({ type: "hello" });
  await a.next();
  a.send({ type: "message.send", requestId: "r1", text: "やあ" });
  await a.next();
  chat.emit({ type: "message.delta", sessionId: "c1", text: "一つ目。" });
  const first = await a.next();
  assert.equal(first.eventId, "1");

  // 電波が切れて、古い接続が残ったまま新しい接続が来る
  const b = connect(server.port);
  await b.opened;
  assert.equal(await a.closed, 4000);
  chat.emit({ type: "message.delta", sessionId: "c1", text: "二つ目。" });
  b.send({ type: "hello", lastEventId: "1" });
  const ok = await b.next();
  assert.deepEqual([ok.type, ok.replay], ["hello.ok", 1]);
  const replayed = await b.next();
  assert.deepEqual([replayed.text, replayed.eventId], ["二つ目。", "2"]);

  b.send({ type: "ack", eventId: "2" });
  b.ws.close();
  await b.closed;
  const c = connect(server.port);
  await c.opened;
  c.send({ type: "hello", lastEventId: "2" });
  assert.equal((await c.next()).replay, 0);
  c.ws.close();
  await server.close();
});

test("events are kept per device: another device never sees them", async () => {
  const { server, chat } = await boot();
  const a = connect(server.port);
  await a.opened;
  a.send({ type: "hello" });
  await a.next();
  a.send({ type: "message.send", requestId: "r1", text: "やあ" });
  await a.next();
  chat.emit({ type: "message.delta", sessionId: "c1", text: "秘密。" });
  await a.next();

  const o = connect(server.port, "o".repeat(32));
  await o.opened;
  o.send({ type: "hello" });
  assert.equal((await o.next()).replay, 0);
  a.ws.close();
  o.ws.close();
  await server.close();
});

test("a client that stops answering pings is dropped", async () => {
  const { server } = await boot({ heartbeatMs: 40 });
  const c = connect(server.port, TOKEN, { autoPong: false });
  await c.opened;
  c.send({ type: "hello" });
  await c.next();
  const code = await Promise.race([c.closed, new Promise<string>((r) => setTimeout(() => r("still open"), 1500))]);
  assert.notEqual(code, "still open");
  await server.close();
});

test("oversized messages close the connection", async () => {
  const { server } = await boot({ maxPayload: 1024 });
  const c = connect(server.port);
  await c.opened;
  c.send({ type: "hello" });
  await c.next();
  c.ws.send("x".repeat(5000));
  assert.equal(await c.closed, 1009);
  await server.close();
});

test("a probe connection answers hello.ok with the instance id, closes, and does not disturb the live connection", async () => {
  const { server, chat } = await boot();
  const live = connect(server.port);
  await live.opened;
  live.send({ type: "hello" });
  const liveHello = await live.next();

  const probe = connect(server.port, TOKEN, {}, "/?probe=1");
  await probe.opened;
  const ok = await probe.next();
  assert.deepEqual([ok.type, ok.deviceId, ok.replay, ok.instanceId], ["hello.ok", "pixel", 0, liveHello.instanceId]);
  assert.equal(await probe.closed, 1000);

  // 本番の接続は置き換えられておらず、そのままイベントを受け取れる
  live.send({ type: "message.send", requestId: "r1", text: "やあ" });
  assert.equal((await live.next()).type, "request.accepted");
  chat.emit({ type: "message.delta", sessionId: "c1", text: "生きています。" });
  assert.equal((await live.next()).text, "生きています。");

  // 間違ったトークンは、プローブでも 401
  await assert.rejects(connect(server.port, "wrong-token", {}, "/?probe=1").opened, /HTTP 401/);
  live.ws.close();
  await server.close();
});

test("a refused connection is logged with fingerprints of the presented and expected tokens, never the tokens", async () => {
  const logs: { msg: string; meta: any }[] = [];
  const { server } = await boot({ log: (_l, msg, meta) => logs.push({ msg, meta }) });
  try {
    const wrong = "w".repeat(32);
    await assert.rejects(connect(server.port, wrong).opened, /HTTP 401/);
    await assert.rejects(connect(server.port, null).opened, /HTTP 401/);

    const refused = logs.filter((l) => l.msg === "unauthorized connection attempt");
    assert.equal(refused.length, 2);
    assert.equal(refused[0].meta.presentedFingerprint, tokenFingerprint(wrong));
    assert.deepEqual(refused[0].meta.expected, [
      { deviceId: "pixel", fingerprint: tokenFingerprint(TOKEN), length: TOKEN.length },
      { deviceId: "other", fingerprint: tokenFingerprint("o".repeat(32)), length: 32 },
    ]);
    assert.equal(refused[0].meta.authorization, `Bearer + token of ${wrong.length} characters`);
    assert.equal(refused[0].meta.comparedWith, "pixel");
    assert.match(refused[0].meta.reason, /same length|different length/);
    assert.equal(refused[1].meta.presentedFingerprint, null);
    assert.equal(refused[1].meta.authorization, "absent");
    assert.match(refused[1].meta.reason, /no Bearer token/);
    const text = JSON.stringify(logs);
    assert.ok(!text.includes(wrong) && !text.includes(TOKEN), "tokens themselves are never logged");
  } finally {
    await server.close();
  }
});

test("plain HTTP tells which gateway process answered and each device's token fingerprint, never a token", async () => {
  const { server } = await boot();
  const res = await fetch(`http://127.0.0.1:${server.port}/`);
  const body = await res.text();
  assert.equal(res.status, 426);
  assert.match(body, /WebSocket required/);
  assert.ok(body.includes(`pid=${process.pid}`));
  assert.ok(body.includes(`device pixel: token fingerprint ${tokenFingerprint(TOKEN)}`));
  assert.ok(!body.includes(TOKEN) && !body.includes("o".repeat(32)));
  await server.close();
});

test("a refused connection says exactly what is wrong with the token (truncated, wrong case, invisible character)", async () => {
  const logs: any[] = [];
  const { server } = await boot({ log: (_l, msg, meta) => { if (msg.startsWith("unauthorized")) logs.push(meta); } });
  try {
    const cases: [string, RegExp][] = [
      [TOKEN.slice(0, -2), /truncated: 2 characters shorter/],
      [TOKEN.toUpperCase(), /same length|only in letter case/],
      [`${TOKEN}\u00a0`, /leading or trailing whitespace/], // a non-breaking space, which a copy-paste can add
      [TOKEN.slice(0, 5) + "\u00e9" + TOKEN.slice(6), /outside printable ASCII.*position 5/], // a non-ASCII character that can travel in a header
    ];
    for (const [token] of cases) await assert.rejects(connect(server.port, token).opened, /HTTP 401/);
    assert.equal(logs.length, cases.length);
    cases.forEach(([, re], i) => assert.match(logs[i].reason, re));
  } finally {
    await server.close();
  }
});

test("the refusal log carries the diagnostics supplied by the process (where the expected token came from)", async () => {
  const logs: any[] = [];
  const { server } = await boot({
    log: (_l, msg, meta) => { if (msg.startsWith("unauthorized")) logs.push(meta); },
    diagnostics: { tokenSource: "environment variable (the value in .env is NOT used)", cwd: "C:\\work\\gateway" },
  });
  try {
    await assert.rejects(connect(server.port, "x".repeat(40)).opened, /HTTP 401/);
    assert.equal(logs[0].tokenSource, "environment variable (the value in .env is NOT used)");
    assert.equal(logs[0].cwd, "C:\\work\\gateway");
  } finally {
    await server.close();
  }
});
