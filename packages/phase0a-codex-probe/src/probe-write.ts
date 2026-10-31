// Phase 0A 書き込み試験 (P0-03, P0-04 の材料, P0-06)。
// 実行条件(すべて必要):
//   - 環境変数 VAG_PROBE_THREAD_ID = Codex Desktop で作った専用検証スレッドのID
//   - 引数 --allow-write
//   - そのスレッドの name が "vag-probe" で始まること(違えば何も送らず中止)
// 送る指示は無害な固定文のみ。メソッド名・パラメータは未検証の仮定(エラー文がスキーマの手がかり)。
import { writeFileSync, mkdirSync } from "node:fs";
import { startAppServer } from "./rpc.ts";

const threadId = process.env.VAG_PROBE_THREAD_ID;
if (!threadId || !process.argv.includes("--allow-write")) {
  console.error("VAG_PROBE_THREAD_ID と --allow-write が必要です。中止。");
  process.exit(2);
}

const PROMPT = "[vag-probe] This is a connectivity test. Reply with exactly the single word OK. Do not run any commands, edit any files, or search the web.";
const WAIT_MS = 120_000;
const srv = startAppServer();
const errText = (r: { error?: unknown }) => JSON.stringify(r.error).slice(0, 300);

async function readAllItems(turnId: string) {
  const all: any[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const r = await srv.request("thread/items/list", { threadId, turnId, ...(cursor ? { cursor } : {}) });
    if (r.error) throw new Error(`items/list: ${errText(r)}`);
    all.push(...(r.result?.data ?? []));
    cursor = r.result?.nextCursor ?? null;
    if (!cursor) break;
  }
  return all;
}

async function snapshot() {
  const t = await srv.request("thread/turns/list", { threadId });
  if (t.error) throw new Error(`turns/list: ${errText(t)}`);
  const turns: any[] = t.result?.data ?? [];
  const items: Record<string, string[]> = {};
  for (const turn of turns) items[turn.id] = (await readAllItems(turn.id)).map((x) => x.item?.id);
  const revision = (await srv.request("thread/read", { threadId })).result?.readState?.revision;
  return { turnIds: turns.map((x) => x.id), items, revision };
}

try {
  await srv.request("initialize", { clientInfo: { name: "vag-probe-write", version: "0.0.1" } });

  const head = await srv.request("thread/read", { threadId });
  const name: string | undefined = head.result?.thread?.name;
  if (!name?.startsWith("vag-probe")) {
    throw new Error(`スレッド名が vag-probe で始まらないため中止 (name=${JSON.stringify(name)})`);
  }
  console.log(`target thread ok: status=${JSON.stringify(head.result.thread.status)}`);

  const before = await snapshot();
  console.log(`before: turns=${before.turnIds.length} items=${Object.values(before.items).flat().length} revision=${before.revision}`);

  // スレッドをこのプロセスにロードする(未検証の仮定: thread/resume)
  const resume = await srv.request("thread/resume", { threadId });
  console.log("thread/resume", resume.error ? `ERROR ${errText(resume)}` : "ok", JSON.stringify(resume.result?.thread?.status ?? null));

  // 指示の追記(未検証の仮定: turn/start + input[])
  const sentAt = Date.now();
  const start = await srv.request("turn/start", { threadId, input: [{ type: "text", text: PROMPT }] });
  console.log("turn/start", start.error ? `ERROR ${errText(start)}` : "accepted");
  if (start.error) throw new Error("turn/start failed; see transcript");

  // 完了通知を待つ(P0-06: どの通知が届くかを記録)
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { console.log("wait timeout (no completion notification)"); resolve(); }, WAIT_MS);
    srv.onNotification((n) => {
      console.log(`+${((n.at - sentAt) / 1000).toFixed(1)}s [notification] ${n.method}`);
      if (/turn\/completed|turn\/failed|turn\/aborted/.test(n.method)) { clearTimeout(timer); resolve(); }
    });
  });

  const after = await snapshot();
  const beforeIds = new Set(Object.values(before.items).flat());
  const newIds = Object.values(after.items).flat().filter((i) => !beforeIds.has(i));
  console.log(`after: turns=${after.turnIds.length} newItems=${newIds.length} revision=${after.revision} (changed=${after.revision !== before.revision})`);
  const counts: Record<string, number> = {};
  for (const n of srv.notifications) counts[n.method] = (counts[n.method] ?? 0) + 1;
  console.log("notification counts", JSON.stringify(counts));
  console.log("次: Codex Desktop を目視確認(P0-04): 新しい指示とOKの返答が表示されているか、再起動が必要だったか。");
} catch (e) {
  console.error("probe-write failed:", (e as Error).message);
  process.exitCode = 1;
} finally {
  mkdirSync(new URL("../out/", import.meta.url), { recursive: true });
  writeFileSync(new URL("../out/write-transcript.json", import.meta.url), JSON.stringify(srv.transcript, null, 2));
  srv.close();
}
