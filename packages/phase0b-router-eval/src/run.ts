import { readFileSync } from "node:fs";
import type { Router, RoutingDecision, SessionIndex } from "../../shared/src/types.ts";
import { RuleRouter } from "./rule-router.ts";
import { tfidfRetriever } from "./retrievers.ts";

interface Case {
  category: string;
  utterance: string;
  currentSessionId?: string;
  expect: { destination: string; sessionId?: string; action?: "create"; mustConfirm?: boolean; intent?: string };
}

const dataDir = new URL("../data/", import.meta.url);
const load = <T>(f: string): T => JSON.parse(readFileSync(new URL(f, dataDir), "utf8"));

// 最終評価データ(final)は閾値・ルール確定後に1回だけ使う(§11.4)
const split = process.argv.includes("--split=final") ? "final" : "dev";
const verbose = process.argv.includes("--verbose");
const sweep = process.argv.includes("--sweep");
const sessions = load<SessionIndex[]>("sessions.json");
const cases = load<Case[]>(`${split}.json`);

function isWrongDispatch(d: RoutingDecision, e: Case["expect"]): boolean {
  if (d.action === "confirm" || d.action === "reject") return false; // 実送信していない
  if (e.mustConfirm) return true; // 確認すべきものを自動送信した
  if ((d.intent ?? "send") !== (e.intent ?? "send")) return true;
  if (d.destination !== e.destination) return true;
  if (e.sessionId) return d.sessionId !== e.sessionId;
  return e.action === "create" ? d.action !== "create" : false;
}

interface Result { agent: number; sess: number; sessN: number; wrong: number; confirm: number; n: number; ms: number }
const cat = (): Result => ({ agent: 0, sess: 0, sessN: 0, wrong: 0, confirm: 0, n: 0, ms: 0 });

function evaluate(router: Router, rows?: string[]) {
  const total = cat();
  const byCat = new Map<string, Result>();
  for (const c of cases) {
    const t0 = performance.now();
    const d = router.route(c.utterance, { currentSessionId: c.currentSessionId, sessions });
    const ms = performance.now() - t0;
    const wd = isWrongDispatch(d, c.expect);
    for (const r of [total, byCat.get(c.category) ?? byCat.set(c.category, cat()).get(c.category)!]) {
      r.n++; r.ms += ms;
      if (d.destination === c.expect.destination) r.agent++;
      if (c.expect.sessionId) { r.sessN++; if (d.sessionId === c.expect.sessionId) r.sess++; }
      if (d.action === "confirm") r.confirm++;
      if (wd) r.wrong++;
    }
    rows?.push(`${wd ? "WRONG" : "ok   "} ${d.action.padEnd(7)} ${(d.sessionId ?? d.destination).padEnd(11)} [${c.category}] ${c.utterance}  (${d.reason})`);
  }
  return { total, byCat };
}

const pct = (a: number, b: number) => (b ? `${(100 * a / b).toFixed(1)}%` : "n/a");

const routers: Router[] = [
  new RuleRouter({ name: "A0:keyword,base" }),
  new RuleRouter({ name: "A1:+confirmVague", confirmVague: true }),
  new RuleRouter({ name: "A2:+crossAgentConfirm", confirmVague: true, crossAgentConfirm: true }),
  new RuleRouter({ name: "A3:+minAutoScore=2", confirmVague: true, crossAgentConfirm: true, minAutoScore: 2 }),
  new RuleRouter({ name: "B':tfidf(2-gram,placeholder for embedding)", retrieve: tfidfRetriever(sessions), margin: 0.1, minTop: 0.2, confirmVague: true }),
];

const summary: string[] = [];
for (const router of routers) {
  const rows: string[] = [];
  const { total, byCat } = evaluate(router, rows);
  console.log(`\n== ${router.name} / ${split} (${total.n} cases) ==`);
  if (verbose) console.log(rows.join("\n"));
  else console.log(rows.filter((r) => r.startsWith("WRONG")).join("\n") || "(no wrong dispatch)");
  console.log(`Agent Accuracy      ${pct(total.agent, total.n)}`);
  console.log(`Session Accuracy    ${pct(total.sess, total.sessN)} (${total.sess}/${total.sessN})`);
  console.log(`Wrong Dispatch Rate ${pct(total.wrong, total.n)} (${total.wrong}/${total.n})`);
  console.log(`Confirmation Rate   ${pct(total.confirm, total.n)} (${total.confirm}/${total.n})`);
  console.log(`Routing Latency     ${(total.ms / total.n).toFixed(3)} ms/utt`);
  console.log("per category (wrong/confirm/n):");
  for (const [k, r] of byCat) console.log(`  ${k.padEnd(13)} ${r.wrong}/${r.confirm}/${r.n}`);
  summary.push(`${router.name.padEnd(44)} WDR ${pct(total.wrong, total.n).padEnd(6)} Confirm ${pct(total.confirm, total.n).padEnd(6)} Agent ${pct(total.agent, total.n).padEnd(6)} Session ${pct(total.sess, total.sessN)}`);
}
console.log(`\n== summary / ${split} ==\n${summary.join("\n")}`);

if (sweep) {
  // 閾値と誤配送・確認要求のトレードオフ。選ぶのは dev のみで行い、final では再調整しない。
  console.log(`\n== sweep: tfidf margin x minTop / ${split} ==`);
  console.log("minTop margin  WDR   Confirm");
  for (const minTop of [0.1, 0.15, 0.2, 0.25, 0.3, 0.4]) {
    for (const margin of [0, 0.05, 0.1, 0.2]) {
      const r = new RuleRouter({ retrieve: tfidfRetriever(sessions), margin, minTop });
      const { total } = evaluate(r);
      console.log(`${String(minTop).padEnd(6)} ${String(margin).padEnd(7)} ${pct(total.wrong, total.n).padEnd(6)}${pct(total.confirm, total.n)}`);
    }
  }
}
