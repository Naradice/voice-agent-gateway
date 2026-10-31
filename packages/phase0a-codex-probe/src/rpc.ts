import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface Notification { at: number; method: string; params: any }

/** `codex app-server` を起動し、JSON-RPC (JSONL over stdio) を話す最小クライアント。 */
export function startAppServer() {
  const child = spawn(process.env.CODEX_BIN ?? "codex", ["app-server"], { stdio: ["pipe", "pipe", "inherit"], shell: process.platform === "win32" });
  const pending = new Map<number, (r: { result?: any; error?: any }) => void>();
  const transcript: unknown[] = [];
  const notifications: Notification[] = [];
  const listeners: ((n: Notification) => void)[] = [];
  let nextId = 1;

  createInterface({ input: child.stdout! }).on("line", (line) => {
    let msg: any;
    try { msg = JSON.parse(line); } catch { transcript.push({ raw: line }); return; }
    transcript.push({ dir: "in", at: Date.now(), msg });
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); return; }
    const n = { at: Date.now(), method: String(msg.method ?? "?"), params: msg.params };
    notifications.push(n);
    listeners.forEach((l) => l(n));
  });

  function request(method: string, params: unknown = {}, timeoutMs = 15000) {
    const id = nextId++;
    const out = { jsonrpc: "2.0", id, method, params };
    transcript.push({ dir: "out", at: Date.now(), msg: out });
    child.stdin!.write(JSON.stringify(out) + "\n");
    return new Promise<{ result?: any; error?: any }>((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
    });
  }

  return {
    request,
    transcript,
    notifications,
    onNotification: (l: (n: Notification) => void) => { listeners.push(l); },
    close: () => child.kill(),
  };
}
