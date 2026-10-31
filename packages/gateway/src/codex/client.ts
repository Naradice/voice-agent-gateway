import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { AgentError } from "../adapter.ts";

export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

/** サーバー発のメッセージ。id があれば応答が必要なリクエスト、なければ通知。 */
export interface ServerMessage { method: string; params: any; id?: number | string }

/** `codex app-server` (JSON-RPC, JSONL over stdio) の最小クライアント。1インスタンス = 1プロセス。 */
export class CodexClient {
  private child: ChildProcess;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }>();
  private listeners: ((m: ServerMessage) => void)[] = [];
  private nextId = 1;
  private exited = false;
  readonly closed: Promise<void>;

  constructor(command: string[] = ["codex", "app-server"]) {
    const [cmd, ...args] = command;
    this.child = spawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"], shell: process.platform === "win32" && cmd === "codex" });
    this.child.stdin!.on("error", () => {}); // 終了済みプロセスへの書き込み(EPIPE)は exit 側で処理する
    createInterface({ input: this.child.stdout! }).on("line", (line) => this.onLine(line));
    this.closed = new Promise((resolve) => {
      const done = (why: string) => {
        if (this.exited) return;
        this.exited = true;
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new AgentError("unavailable", `codex app-server ${why}`));
          this.pending.delete(id);
        }
        resolve();
      };
      this.child.on("error", (e) => done(`failed to start: ${e.message}`));
      this.child.on("exit", () => done("exited"));
    });
  }

  private onLine(line: string) {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    // method を持つものはサーバー発(こちらが出した id と衝突しうるため、応答判定には使わない)
    if (msg.method === undefined && msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(msg.error.code ?? 0, String(msg.error.message ?? "")));
      else p.resolve(msg.result);
      return;
    }
    const m: ServerMessage = { method: String(msg.method ?? ""), params: msg.params, id: msg.id };
    for (const l of this.listeners) l(m);
  }

  request(method: string, params: unknown = {}, timeoutMs = 15000): Promise<any> {
    if (this.exited) return Promise.reject(new AgentError("unavailable", "codex app-server is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AgentError("unavailable", `timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  /** サーバー発リクエストへの応答。 */
  reply(id: number | string, body: { result: unknown } | { error: { code: number; message: string } }): void {
    if (!this.exited) this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\n");
  }

  onMessage(l: (m: ServerMessage) => void): void {
    this.listeners.push(l);
  }

  close(): void {
    if (!this.exited) this.child.kill();
  }
}
