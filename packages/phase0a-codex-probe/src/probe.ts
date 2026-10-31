// Phase 0A: Codex App Server 読み取り専用プローブ (P0-01, P0-02, P0-06)。
// 書き込み系メソッド(turn/start 等)は意図的に実装しない。設計書 §10.2: 読み取り合格後のみ書き込み試験。
//
// 注意: 下記のメソッド名は未検証の仮定。実機で `codex app-server generate-ts` 等により
// 公式スキーマを生成し、差異があればここを直すこと。
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync, mkdirSync } from "node:fs";

const METHODS = { initialize: "initialize", listThreads: "thread/list", readThread: "thread/read" } as const;

const child = spawn(process.env.CODEX_BIN ?? "codex", ["app-server"], { stdio: ["pipe", "pipe", "inherit"], shell: process.platform === "win32" });
const pending = new Map<number, (r: { result?: unknown; error?: unknown }) => void>();
const transcript: unknown[] = [];
let nextId = 1;

createInterface({ input: child.stdout! }).on("line", (line) => {
  let msg: any;
  try { msg = JSON.parse(line); } catch { transcript.push({ raw: line }); return; }
  transcript.push({ dir: "in", msg });
  if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
  else console.log("[notification]", msg.method ?? msg);
});

function request(method: string, params: unknown = {}, timeoutMs = 15000) {
  const id = nextId++;
  const out = { jsonrpc: "2.0", id, method, params };
  transcript.push({ dir: "out", msg: out });
  child.stdin!.write(JSON.stringify(out) + "\n");
  return new Promise<{ result?: any; error?: unknown }>((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
  });
}

try {
  const init = await request(METHODS.initialize, { clientInfo: { name: "vag-probe", version: "0.0.1" } });
  console.log("P0-init", JSON.stringify(init).slice(0, 300));
  const list = await request(METHODS.listThreads, {});
  console.log("P0-01 thread list", JSON.stringify(list).slice(0, 600));
  const first = list.result?.data?.[0]?.id ?? list.result?.threads?.[0]?.id;
  if (first) console.log("P0-02 thread read", JSON.stringify(await request(METHODS.readThread, { threadId: first })).slice(0, 600));
  else console.log("P0-02 skipped: no thread id found in list response (check schema)");
} catch (e) {
  console.error("probe failed:", (e as Error).message);
  process.exitCode = 1;
} finally {
  mkdirSync(new URL("../out/", import.meta.url), { recursive: true });
  writeFileSync(new URL("../out/transcript.json", import.meta.url), JSON.stringify(transcript, null, 2));
  child.kill();
}
