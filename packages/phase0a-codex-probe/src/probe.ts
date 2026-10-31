// Phase 0A: Codex App Server 読み取り専用プローブ (P0-01, P0-02, P0-06)。
// 書き込み系メソッド(turn/start 等)は意図的に実装しない。設計書 §10.2: 読み取り合格後のみ書き込み試験。
//
// 注意: 下記のメソッド名は未検証の仮定。実機で `codex app-server generate-ts` 等により
// 公式スキーマを生成し、差異があればここを直すこと。
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync, mkdirSync } from "node:fs";

const METHODS = { initialize: "initialize", listThreads: "thread/list", readThread: "thread/read", listTurns: "thread/turns/list", listItems: "thread/items/list" } as const;

const child = spawn(process.env.CODEX_BIN ?? "codex", ["app-server"], { stdio: ["pipe", "pipe", "inherit"], shell: process.platform === "win32" });
const pending = new Map<number, (r: { result?: unknown; error?: unknown }) => void>();
const transcript: unknown[] = [];
let nextId = 1;

createInterface({ input: child.stdout! }).on("line", (line) => {
  let msg: any;
  try { msg = JSON.parse(line); } catch { transcript.push({ raw: line }); return; }
  transcript.push({ dir: "in", msg });
  if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
  else console.log("[notification]", msg.method ?? "?", JSON.stringify(msg.method === "deprecationNotice" ? msg.params : shape(msg.params, 0, 2)));
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

// 本文(プライバシー)は出力せず、構造だけ要約する。生データは out/transcript.json(gitignore済み)。
function shape(v: unknown, depth = 0, max = 3): unknown {
  if (Array.isArray(v)) return `array(${v.length})` + (v.length && depth < max ? ` of ${JSON.stringify(shape(v[0], depth + 1, max))}` : "");
  if (v && typeof v === "object") return depth >= max ? "object" : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1, max)]));
  return v === null ? "null" : typeof v === "string" ? `string(${v.length})` : typeof v;
}

// 本文を含まない短い項目だけ値を出す。
const pick = (t: any) => ({ status: t?.status, historyMode: t?.historyMode, source: t?.source, threadSource: t?.threadSource, originator: t?.originator, cliVersion: t?.cliVersion, modelProvider: t?.modelProvider, canAcceptDirectInput: t?.canAcceptDirectInput, ephemeral: t?.ephemeral });

try {
  const init = await request(METHODS.initialize, { clientInfo: { name: "vag-probe", version: "0.0.1" } });
  console.log("init shape", JSON.stringify(shape(init.result)));
  const list = await request(METHODS.listThreads, {});
  const threads = list.result?.data ?? [];
  console.log(`P0-01 thread/list: ${threads.length} threads, nextCursor=${JSON.stringify(list.result?.nextCursor ?? null)}`);
  console.log("P0-01 thread shape", JSON.stringify(shape(threads[0])));
  console.log("P0-01 enum values per thread", JSON.stringify(threads.map(pick)));
  const first = threads[0]?.id;
  if (first) {
    // includeTurns は paginated スレッドでは非推奨(deprecationNotice)。正規ルートはページングAPI。
    // パラメータ名は未検証の仮定。エラーメッセージはスキーマの手がかりになる。
    const errText = (r: { error?: unknown }) => JSON.stringify(r.error).slice(0, 300);
    const turns = await request(METHODS.listTurns, { threadId: first });
    console.log("P0-02 thread/turns/list", turns.error ? `ERROR ${errText(turns)}` : JSON.stringify(shape(turns.result, 0, 4)));
    const rows = turns.result?.data ?? turns.result?.turns ?? [];
    console.log(`P0-02 turns=${rows.length} nextCursor=${JSON.stringify(turns.result?.nextCursor ?? null)}`);
    const turnId = rows[0]?.id;
    if (turnId) {
      const items = await request(METHODS.listItems, { threadId: first, turnId });
      console.log("P0-02 thread/items/list", items.error ? `ERROR ${errText(items)}` : JSON.stringify(shape(items.result, 0, 4)));
      const arr: any[] = items.result?.data ?? items.result?.items ?? [];
      const hist: Record<string, number> = {};
      for (const it of arr) hist[it.type] = (hist[it.type] ?? 0) + 1;
      console.log(`P0-02 items=${arr.length} (includeTurns では 78) nextCursor=${JSON.stringify(items.result?.nextCursor ?? null)} types=${JSON.stringify(hist)}`);
    }
    console.log("P0-02 readState", JSON.stringify((await request(METHODS.readThread, { threadId: first })).result?.readState));
  } else console.log("P0-02 skipped: no thread found");
} catch (e) {
  console.error("probe failed:", (e as Error).message);
  process.exitCode = 1;
} finally {
  mkdirSync(new URL("../out/", import.meta.url), { recursive: true });
  writeFileSync(new URL("../out/transcript.json", import.meta.url), JSON.stringify(transcript, null, 2));
  child.kill();
}
