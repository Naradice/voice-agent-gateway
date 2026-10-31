// Gateway の起動。設定はすべて環境変数から読む(秘密情報をファイルやリポジトリに置かない)。
//   設定はカレントディレクトリの .env からも読む(npm run gateway:init で作成。実際の環境変数が優先)。
//   VAG_DEVICES   必須。[{"deviceId":"pixel","token":"24文字以上のランダム文字列"}]
//   VAG_HOST      待ち受けアドレス。既定 127.0.0.1。Tailscale 経由なら Tailscale の IP(100.x.x.x)を指定する
//   VAG_PORT      既定 8787
//   VAG_DB        SQLite のパス。既定 data/gateway.sqlite
//   VAG_CODEX     1 で Codex Adapter を有効にする
//   LOCAL_MODEL(既定 qwen3:14b) OLLAMA_BASE_URL LOCAL_CONTEXT VAG_KEEP_ALIVE(既定 10m)
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

const registry = new AdapterRegistry();
registry.register(new LocalLLMAdapter({
  store, model, baseUrl: ollama,
  contextTokens: env.LOCAL_CONTEXT ? Number(env.LOCAL_CONTEXT) : undefined,
  instructions: "あなたは音声アシスタントです。短く、話し言葉で答えてください。コードや長いURLは読み上げません。",
  lifecycle: new OllamaLifecycle({ model, baseUrl: ollama, keepAlive: env.VAG_KEEP_ALIVE ?? "10m" }),
  grounding: provider && createGrounding({
    provider,
    onSearch: (i) => log("info", "web search", { provider: i.provider, external: i.external }), // 検索語は記録しない
  }),
}));
if (env.VAG_CODEX === "1") registry.register(new CodexAdapter());

const gateway = new Gateway({
  store, registry, log,
  // 暫定の設定(Phase 0B の A2 相当)。許容する確認率が決まったら見直す。
  router: new RuleRouter({ name: "gateway", confirmVague: true, crossAgentConfirm: true }),
});

const port = Number(env.VAG_PORT ?? 8787);
const server = await startServer({ gateway, devices, host, port, log }).catch((e: NodeJS.ErrnoException) => {
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
