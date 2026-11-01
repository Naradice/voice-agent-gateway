// Gateway の起動。設定はすべて環境変数から読む(秘密情報をファイルやリポジトリに置かない)。
//   設定はカレントディレクトリの .env からも読む(npm run gateway:init で作成。実際の環境変数が優先)。
//   VAG_DEVICES   必須。[{"deviceId":"pixel","token":"24文字以上のランダム文字列"}]
//   VAG_HOST      待ち受けアドレス。既定 127.0.0.1。Tailscale 経由なら Tailscale の IP(100.x.x.x)を指定する
//   VAG_PORT      既定 8787
//   VAG_DB        SQLite のパス。既定 data/gateway.sqlite
//   VAG_CODEX     1 で Codex Adapter を有効にする
//   LOCAL_MODEL(既定 qwen3:14b) OLLAMA_BASE_URL CODEX_POLL_SECONDS(既定 60。0 で無効) LOCAL_CONTEXT LOCAL_USER_PROFILE LOCAL_TIMEZONE VAG_KEEP_ALIVE(既定 10m)
//   SEARCH_PROVIDER=brave|searxng, BRAVE_API_KEY / SEARXNG_URL
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
// 暫定: ルーターは評価用パッケージにある。安定したら独立したパッケージへ移す。
import { RuleRouter } from "../../phase0b-router-eval/src/rule-router.ts";
import { CodexAdapter } from "./codex/adapter.ts";
import { checkHost, fail, jsonLog, parseDevices } from "./config.ts";
import { loadDotEnv, shadowedMessage, sourceOf } from "./env.ts";
import { tokenFingerprint } from "./connection.ts";
import { Gateway } from "./gateway.ts";
import { CompletionWatcher } from "./watch.ts";
import { LocalLLMAdapter } from "./local/adapter.ts";
import { OllamaLifecycle } from "./local/lifecycle.ts";
import { AdapterRegistry } from "./registry.ts";
import { BraveSearch } from "./search/brave.ts";
import { createGrounding } from "./search/grounding.ts";
import { SearxngSearch } from "./search/searxng.ts";
import { startServer } from "./server.ts";
import { Store } from "./store.ts";

const dot = loadDotEnv();
const shadow = shadowedMessage(dot);
if (shadow) console.warn(`警告: ${shadow}`);
const env = process.env;

const devices = parseDevices(env.VAG_DEVICES);
// Which token is this process really using, and where did it come from? Compare the fingerprint with the app's.
for (const d of devices) {
  console.log(`device ${d.deviceId}: token fingerprint ${tokenFingerprint(d.token)}  [from ${sourceOf(dot, "VAG_DEVICES")}]`);
}
const host = checkHost(env.VAG_HOST ?? "127.0.0.1");
const log = jsonLog;

const dbPath = env.VAG_DB ?? "data/gateway.sqlite";
mkdirSync(dirname(dbPath), { recursive: true });
const store = new Store(dbPath);

const model = env.LOCAL_MODEL ?? "qwen3:14b";
const ollama = env.OLLAMA_BASE_URL;
const provider =
  env.SEARCH_PROVIDER === "brave" ? new BraveSearch({ apiKey: env.BRAVE_API_KEY ?? fail("BRAVE_API_KEY が未設定です") })
  : env.SEARCH_PROVIDER === "searxng" ? new SearxngSearch({ baseUrl: env.SEARXNG_URL ?? "http://127.0.0.1:8080" })
  : undefined;

// 数値の設定(未設定なら undefined)。不正な値は起動時に止める。
const intEnv = (name: string): number | undefined => {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fail(`${name} は正の整数にしてください(現在: ${raw})`);
};
const historyChars = intEnv("LOCAL_HISTORY_CHARS");
const maxTokens = intEnv("LOCAL_MAX_TOKENS");

const registry = new AdapterRegistry();
registry.register(new LocalLLMAdapter({
  store, model, baseUrl: ollama,
  contextTokens: env.LOCAL_CONTEXT ? Number(env.LOCAL_CONTEXT) : undefined,
  // CPU は長い履歴の処理が遅い。履歴を短くし、返答も短く打ち切る(音声向け)。
  ...(historyChars ? { maxHistoryChars: historyChars } : {}),
  // 思考を止める指定を送るか。未指定なら自動(instruct を名前に含むモデルには送らない)。LOCAL_SUPPRESS_THINKING=0 で送らない、=1 で必ず送る。
  ...(env.LOCAL_SUPPRESS_THINKING === "0" ? { suppressThinking: false } : env.LOCAL_SUPPRESS_THINKING === "1" ? { suppressThinking: true } : {}),
  ...(maxTokens ? { extraBody: { max_tokens: maxTokens } } : {}),
  userProfile: env.LOCAL_USER_PROFILE,
  timeZone: env.LOCAL_TIMEZONE,
  instructions: "あなたは音声アシスタントです。短く、話し言葉で答えてください。コードや長いURLは読み上げません。",
  lifecycle: new OllamaLifecycle({ model, baseUrl: ollama, keepAlive: env.VAG_KEEP_ALIVE ?? "10m" }),
  grounding: provider && createGrounding({
    provider,
    onSearch: (i) => log("info", "web search", { provider: i.provider, external: i.external }), // 検索語は記録しない
  }),
}));
if (env.VAG_CODEX === "1") registry.register(new CodexAdapter());

// Codex のスレッドを定期的に確認し、作業が終わったものを待機メッセージにする(自動では読み上げない)
let watcher: CompletionWatcher | undefined;
const pollSeconds = env.CODEX_POLL_SECONDS === undefined ? 60 : Number(env.CODEX_POLL_SECONDS);
const gateway = new Gateway({
  store, registry, log,
  onOwnSend: (destination, sessionId) => { if (destination === "codex") watcher?.noteOwn(sessionId); },
  // 暫定の設定(Phase 0B の A2 相当)。許容する確認率が決まったら見直す。
  router: new RuleRouter({ name: "gateway", confirmVague: true, crossAgentConfirm: true }),
});

const codexAdapter = registry.get("codex");
if (codexAdapter && Number.isFinite(pollSeconds) && pollSeconds >= 10) {
  watcher = new CompletionWatcher({
    adapter: codexAdapter, intervalMs: pollSeconds * 1000, log,
    onSettled: (s) => gateway.notify({ kind: "turn_settled", sessionId: s.id, destination: "codex", text: `Codexの「${s.title}」で作業が一区切りしました。` }),
  });
  watcher.start();
}

const port = Number(env.VAG_PORT ?? 8787);
const server = await startServer({ gateway, devices, host, port, log, diagnostics: { tokenSource: sourceOf(dot, "VAG_DEVICES"), cwd: process.cwd() } }).catch((e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    return fail(`${host}:${port} は他のプロセスが使用中です。古い Gateway が動いたままではありませんか。` +
      `\n  確認: netstat -ano | findstr :${port}   停止: taskkill /PID <PID> /F`);
  }
  throw e;
});
log("info", "gateway started", {
  host, port: server.port, agents: registry.list().map((a) => a.agentType), search: provider?.name ?? "off",
  envFile: dot.loaded ? dot.path : null,
  tokenSource: sourceOf(dot, "VAG_DEVICES"),
  // 確認コードは、アプリの設定画面に出るものと比べるための値(トークン本体ではない)
  devices: devices.map((d) => ({ deviceId: d.deviceId, tokenFingerprint: tokenFingerprint(d.token) })),
});

const shutdown = async () => {
  log("info", "shutting down");
  await server.close();
  store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
