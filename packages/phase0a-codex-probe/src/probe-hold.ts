// Phase 0A: Gateway がスレッドを保持している間の Desktop 側の挙動を観察する (P0-05)。
// 何も送信しない(resume のみ)。条件は probe-write.ts と同じ(専用スレッド + --allow-write)。
import { writeFileSync, mkdirSync } from "node:fs";
import { startAppServer } from "./rpc.ts";

const threadId = process.env.VAG_PROBE_THREAD_ID;
const HOLD_MS = Number(process.env.VAG_HOLD_SECONDS ?? 180) * 1000;
if (!threadId || !process.argv.includes("--allow-write")) {
  console.error("VAG_PROBE_THREAD_ID と --allow-write が必要です。中止。");
  process.exit(2);
}

const srv = startAppServer();
try {
  await srv.request("initialize", { clientInfo: { name: "vag-probe-hold", version: "0.0.1" } });
  const head = await srv.request("thread/read", { threadId });
  const name: string | undefined = head.result?.thread?.name;
  if (!name?.startsWith("vag-probe")) throw new Error(`スレッド名が vag-probe で始まらないため中止 (name=${JSON.stringify(name)})`);

  const resume = await srv.request("thread/resume", { threadId });
  if (resume.error) throw new Error(`thread/resume failed: ${JSON.stringify(resume.error).slice(0, 300)}`);
  const t0 = Date.now();
  console.log(`holding thread for ${HOLD_MS / 1000}s. この間に Codex Desktop で同じスレッドを開き、次を観察して記録してください:`);
  console.log("  (a) 開けるか / エラーや読み取り専用表示になるか  (b) 開けた場合、Desktop から1通送れるか  (c) 送れた場合、ここに通知が流れるか");
  srv.onNotification((n) => console.log(`+${((n.at - t0) / 1000).toFixed(1)}s [notification] ${n.method}`));
  await new Promise((r) => setTimeout(r, HOLD_MS));
  console.log("released (process exit)");
} catch (e) {
  console.error("probe-hold failed:", (e as Error).message);
  process.exitCode = 1;
} finally {
  mkdirSync(new URL("../out/", import.meta.url), { recursive: true });
  writeFileSync(new URL("../out/hold-transcript.json", import.meta.url), JSON.stringify(srv.transcript, null, 2));
  srv.close();
}
