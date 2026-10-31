// WebSocket サーバー (Connection Manager, 設計書 §4.2, §9.1)。
// 認証・接続の置き換え・ハートビート・入力の検証だけを担当し、中身の処理は Gateway に委ねる。
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { Gateway, DeviceLink } from "./gateway.ts";
import { tokenFingerprint } from "./connection.ts";
import { parseClientMessage, type ServerMessage } from "./protocol.ts";

export interface DeviceCredential { deviceId: string; token: string }

export interface ServerOptions {
  gateway: Gateway;
  devices: DeviceCredential[];
  host?: string;
  port?: number;
  /** ping の間隔。応答がなければ次の周期で切断する。既定 15 秒 */
  heartbeatMs?: number;
  /** 接続後、hello を送るまでの猶予。既定 5 秒 */
  helloTimeoutMs?: number;
  /** 1メッセージの最大バイト数。既定 64KB */
  maxPayload?: number;
  log?: (level: "info" | "warn" | "error", msg: string, meta?: object) => void;
}

export interface RunningServer { port: number; close(): Promise<void> }

const sha256 = (s: string) => createHash("sha256").update(s).digest();

/** 全デバイスと比較して時間差から推測されないようにする。トークンはログに出さない。 */
function authenticate(req: IncomingMessage, devices: { deviceId: string; hash: Buffer }[]): string | undefined {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
  if (!m) return undefined;
  const given = sha256(m[1]);
  let found: string | undefined;
  for (const d of devices) if (timingSafeEqual(given, d.hash)) found = d.deviceId;
  return found;
}

export function startServer(o: ServerOptions): Promise<RunningServer> {
  const log = o.log ?? (() => {});
  const devices = o.devices.map((d) => ({ deviceId: d.deviceId, hash: sha256(d.token) }));
  const helloTimeoutMs = o.helloTimeoutMs ?? 5000;

  // 通常の HTTP には、どの Gateway プロセスが答えているかを示す。古いプロセスが動いたままで、新しい設定が
  // 反映されていない、という取り違えを、スマホのブラウザから見分けられる。トークン本体は含まない。
  // 確認コード(24ビット)とデバイス名は、tailnet 内の接続元に見えるが、トークンの手がかりにならない。
  const startedAt = new Date().toISOString();
  const http = createServer((_req, res) => {
    const lines = [
      "WebSocket required",
      "",
      `voice-agent-gateway pid=${process.pid} started=${startedAt}`,
      ...o.devices.map((d) => `device ${d.deviceId}: token fingerprint ${tokenFingerprint(d.token)}`),
    ];
    res.writeHead(426, { "content-type": "text/plain; charset=utf-8" }).end(lines.join("\n") + "\n");
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: o.maxPayload ?? 64 * 1024 });
  const sockets = new Map<string, WebSocket>();
  const alive = new WeakMap<WebSocket, boolean>();

  http.on("upgrade", (req, socket, head) => {
    const deviceId = authenticate(req, devices);
    if (!deviceId) {
      // 原因の切り分け用に、送られてきたトークンと、Gateway が期待するトークンの確認コード(6桁)を並べて記録する。
      // 確認コードはトークンの手がかりにならない。不一致なら入力ミスか、古いトークンで動いている。
      const presented = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      log("warn", "unauthorized connection attempt", {
        remote: req.socket.remoteAddress,
        presentedFingerprint: presented ? tokenFingerprint(presented) : "(Authorization なし)",
        expected: o.devices.map((d) => ({ deviceId: d.deviceId, fingerprint: tokenFingerprint(d.token) })),
      });
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req, deviceId));
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage, deviceId: string) => {
    // プローブ接続: 設定画面の「接続テスト」用。認証が通ることと Gateway の識別子だけを返してすぐ閉じる。
    // 接続の置き換えも、未配信イベントの再送も行わない(本番の接続を追い出さない)。
    if (new URL(req.url ?? "/", "http://localhost").searchParams.get("probe") === "1") {
      ws.send(JSON.stringify({ type: "hello.ok", deviceId, serverTime: new Date().toISOString(), replay: 0, instanceId: o.gateway.instanceId() }));
      ws.close(1000, "probe");
      return;
    }
    // 同じ端末の新しい接続が、古い接続を置き換える(再接続時に古い接続が残っていても詰まらない)。
    sockets.get(deviceId)?.close(4000, "replaced");
    sockets.set(deviceId, ws);
    alive.set(ws, true);

    const link: DeviceLink = { send: (m: ServerMessage) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); } };
    let ready = false;
    const helloTimer = setTimeout(() => ws.close(4001, "hello required"), helloTimeoutMs);
    log("info", "device connected", { deviceId });

    ws.on("pong", () => alive.set(ws, true));
    ws.on("error", () => {}); // close イベントで後始末する
    ws.on("message", async (data, isBinary) => {
      if (isBinary) return link.send({ type: "error", code: "invalid", message: "テキストで送ってください" });
      const parsed = parseClientMessage(data.toString());
      if (!parsed.ok) return link.send({ type: "error", code: "invalid", message: parsed.message });
      const msg = parsed.msg;
      if (msg.type === "hello") {
        if (ready) return;
        ready = true;
        clearTimeout(helloTimer);
        o.gateway.attach(deviceId, link, msg.lastEventId, msg.instanceId);
        return;
      }
      if (!ready) return link.send({ type: "error", code: "not_ready", message: "最初に hello を送ってください" });
      try {
        await o.gateway.handle(deviceId, msg);
      } catch (e) {
        log("error", "handler failed", { deviceId, type: msg.type, error: String(e) });
        link.send({ type: "error", code: "internal", message: "処理中にエラーが発生しました" });
      }
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (sockets.get(deviceId) === ws) sockets.delete(deviceId);
      o.gateway.detach(deviceId, link);
      log("info", "device disconnected", { deviceId });
    });
  });

  // 応答のない接続(電波が切れた端末など)を検出して閉じる。
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) { ws.terminate(); continue; }
      alive.set(ws, false);
      ws.ping();
    }
  }, o.heartbeatMs ?? 15_000);

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(o.port ?? 0, o.host ?? "127.0.0.1", () => {
      const addr = http.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : 0,
        close: () => new Promise<void>((done) => {
          clearInterval(heartbeat);
          for (const ws of wss.clients) ws.close(1001, "server shutting down");
          wss.close(() => http.close(() => done()));
          http.closeAllConnections();
        }),
      });
    });
  });
}
