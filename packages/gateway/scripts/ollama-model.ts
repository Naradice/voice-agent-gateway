// GPU を使わない派生モデルを作る(PARAMETER num_gpu 0)。環境変数で GPU を隠す方法(npm run ollama:cpu)が効かない場合の代替で、
// 併用もできる。モデルの側で「GPU に載せる層は 0」と指定するので、どの Ollama で動かしても CPU で動く。
//   npm run ollama:model [-- qwen3:4b]      既定は .env の LOCAL_MODEL(例 qwen3:4b → qwen3-4b-cpu を作る)
// 作成先は OLLAMA_BASE_URL の Ollama(起動している必要がある)。モデルの実体は共有されるので、追加の容量はほぼ要らない。
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotEnv } from "../src/env.ts";
import { cpuModelName, cpuModelfile, portOf } from "../src/local/cpu.ts";

loadDotEnv();
const base = process.argv[2] ?? process.env.LOCAL_MODEL ?? "qwen3:4b";
const name = cpuModelName(base);
const host = new URL(process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").hostname;
const port = portOf(process.env.OLLAMA_BASE_URL, 11434);

const dir = mkdtempSync(join(tmpdir(), "vag-modelfile-"));
const file = join(dir, "Modelfile");
writeFileSync(file, cpuModelfile(base));
console.log(`${name} を作ります(元: ${base}、GPU に載せる層: 0)。作成先: ${host}:${port}`);
const r = spawnSync(process.env.OLLAMA_BIN ?? "ollama", ["create", name, "-f", file], {
  stdio: "inherit",
  env: { ...process.env, OLLAMA_HOST: `${host}:${port}` },
  shell: process.platform === "win32" && !process.env.OLLAMA_BIN,
});
rmSync(dir, { recursive: true, force: true });
if (r.error || r.status !== 0) {
  console.error(`\n作成に失敗しました。Ollama(${host}:${port})が起動しているか、元のモデル ${base} を取得済みか(ollama pull ${base})を確認してください。`);
  process.exit(1);
}
console.log(`\n作成しました。Gateway の .env を次のようにして、確認してください:\n  LOCAL_MODEL=${name}\n  npm run llm -- warm   → 「CPU のみで動いています」と出れば成功`);
