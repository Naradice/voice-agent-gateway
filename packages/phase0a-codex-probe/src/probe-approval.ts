// Phase 0A: P0-08 承認要求の検証。専用検証スレッド(name が "vag-probe" で始まる)にのみ送る。
// 無害な作業(一時フォルダに1ファイル作成)を依頼し、承認要求の形・応答方法・待機の可否を観察する。
//   VAG_PROBE_THREAD_ID     検証スレッドID(必須)
//   VAG_DECISION            承認要求への応答。既定 "decline"(安全側)。"accept" で許可
//   VAG_APPROVAL_DELAY_SEC  応答までの待機秒(既定 5)。「停止してから承認」を想定した待機の確認
// 承認ポリシー/サンドボックスの指定名は未検証の仮定。無視されても依頼内容は一時フォルダへの1ファイルのみ。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAppServer } from "./rpc.ts";

const threadId = process.env.VAG_PROBE_THREAD_ID;
const decision = process.env.VAG_DECISION ?? "decline";
const delayMs = Number(process.env.VAG_APPROVAL_DELAY_SEC ?? 5) * 1000;
if (!threadId || !process.argv.includes("--allow-write")) {
  console.error("VAG_PROBE_THREAD_ID と --allow-write が必要です。中止。");
  process.exit(2);
}

const dir = join(tmpdir(), "vag-probe-p08");
const target = join(dir, "vag-probe-p08.txt");
mkdirSync(dir, { recursive: true });
const PROMPT = `[vag-probe] Create exactly one file at "${target}" containing the text p08. Do nothing else: no other files, no network, no other commands.`;

const srv = startAppServer();
const errText = (r: { error?: unknown }) => JSON.stringify(r.error).slice(0, 300);
const WAIT_MS = 180_000;

try {
  await srv.request("initialize", { clientInfo: { name: "vag-probe-approval", version: "0.0.1" } });
  const head = await srv.request("thread/read", { threadId });
  const name: string | undefined = head.result?.thread?.name;
  if (!name?.startsWith("vag-probe")) throw new Error(`スレッド名が vag-probe で始まらないため中止 (name=${JSON.stringify(name)})`);

  const resume = await srv.request("thread/resume", { threadId });
  if (resume.error) throw new Error(`thread/resume failed: ${errText(resume)}`);

  const t0 = Date.now();
  const seen: string[] = [];
  let approvals = 0;
  const done = new Promise<void>((resolve) => {
    const timer = setTimeout(() => { console.log("wait timeout"); resolve(); }, WAIT_MS);
    srv.onNotification((n) => {
      const at = `+${((n.at - t0) / 1000).toFixed(1)}s`;
      if (n.id === undefined) {
        if (!/mcpServer|tokenUsage|rateLimits|account\//.test(n.method)) console.log(`${at} [notification] ${n.method}`);
        // turn/completed は成功を意味しない。エラー通知・自動審査・ターン結果は中身を出す(検証用の定型文のみ)。
        if (/^error$|autoApprovalReview|turn\/(completed|failed|aborted)/.test(n.method)) console.log("  params:", JSON.stringify(n.params).slice(0, 600));
        seen.push(n.method);
        if (/turn\/(completed|failed|aborted)/.test(n.method)) { clearTimeout(timer); resolve(); }
        return;
      }
      // サーバー発のリクエスト。承認要求なら記録して応答する。
      console.log(`${at} [server-request] ${n.method} id=${n.id}`);
      console.log("  params:", JSON.stringify(n.params).slice(0, 800));
      if (/approval/i.test(n.method)) {
        approvals++;
        console.log(`  → ${delayMs / 1000}s 待ってから decision=${decision} で応答`);
        setTimeout(() => {
          srv.reply(n.id!, { result: { decision } });
          console.log(`  → 応答済み (${decision})`);
        }, delayMs);
      } else {
        srv.reply(n.id!, { error: { code: -32601, message: "vag-probe: unsupported server request" } });
        console.log("  → 未対応のサーバーリクエストなのでエラー応答");
      }
    });
  });

  const start = await srv.request("turn/start", {
    threadId,
    input: [{ type: "text", text: PROMPT }],
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "readOnly" },
  });
  console.log("turn/start", start.error ? `ERROR ${errText(start)}` : "accepted");
  if (start.error) throw new Error("turn/start failed; nothing else was sent");

  await done;
  console.log(`approval requests=${approvals} decision=${decision} fileCreated=${existsSync(target)} (${target})`);
  const counts: Record<string, number> = {};
  for (const m of seen) counts[m] = (counts[m] ?? 0) + 1;
  console.log("notification counts", JSON.stringify(counts));
} catch (e) {
  console.error("probe-approval failed:", (e as Error).message);
  process.exitCode = 1;
} finally {
  mkdirSync(new URL("../out/", import.meta.url), { recursive: true });
  writeFileSync(new URL("../out/approval-transcript.json", import.meta.url), JSON.stringify(srv.transcript, null, 2));
  srv.close();
}
