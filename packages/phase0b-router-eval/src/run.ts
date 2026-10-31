import { readFileSync } from "node:fs";
import type { Router, RoutingDecision, SessionIndex } from "../../shared/src/types.ts";
import { RuleRouter } from "./rule-router.ts";

interface Case {
  utterance: string;
  currentSessionId?: string;
  expect: { destination: string; sessionId?: string; action?: "create"; mustConfirm?: boolean };
}

const dataDir = new URL("../data/", import.meta.url);
const load = <T>(f: string): T => JSON.parse(readFileSync(new URL(f, dataDir), "utf8"));

// 最終評価データ(final)は閾値・ルール確定後に1回だけ使う(§11.4)
const split = process.argv.includes("--split=final") ? "final" : "dev";
const sessions = load<SessionIndex[]>("sessions.json");
const cases = load<Case[]>(`${split}.json`);
const routers: Router[] = [new RuleRouter()];

function isWrongDispatch(d: RoutingDecision, e: Case["expect"]): boolean {
  if (d.action === "confirm" || d.action === "reject") return false; // 実送信していない
  if (e.mustConfirm) return true; // 確認すべきものを自動送信した
  if (d.destination !== e.destination) return true;
  if (e.sessionId) return d.sessionId !== e.sessionId;
  return e.action === "create" ? d.action !== "create" : false;
}

for (const router of routers) {
  let agentOk = 0, sessionOk = 0, sessionN = 0, wrong = 0, confirms = 0;
  const t0 = performance.now();
  const rows: string[] = [];
  for (const c of cases) {
    const d = router.route(c.utterance, { currentSessionId: c.currentSessionId, sessions });
    const wd = isWrongDispatch(d, c.expect);
    if (d.destination === c.expect.destination) agentOk++;
    if (c.expect.sessionId) { sessionN++; if (d.sessionId === c.expect.sessionId) sessionOk++; }
    if (d.action === "confirm") confirms++;
    if (wd) wrong++;
    rows.push(`${wd ? "WRONG" : "ok   "} ${d.action.padEnd(7)} ${(d.sessionId ?? d.destination).padEnd(11)} ${c.utterance}  [${d.reason}]`);
  }
  const ms = (performance.now() - t0) / cases.length;
  const n = cases.length;
  console.log(`\n== ${router.name} / ${split} (${n} cases) ==`);
  console.log(rows.join("\n"));
  console.log(`Agent Accuracy      ${(100 * agentOk / n).toFixed(1)}%`);
  console.log(`Session Accuracy    ${sessionN ? (100 * sessionOk / sessionN).toFixed(1) + "%" : "n/a"} (${sessionOk}/${sessionN})`);
  console.log(`Wrong Dispatch Rate ${(100 * wrong / n).toFixed(1)}% (${wrong}/${n})`);
  console.log(`Confirmation Rate   ${(100 * confirms / n).toFixed(1)}%`);
  console.log(`Routing Latency     ${ms.toFixed(3)} ms/utt`);
}
