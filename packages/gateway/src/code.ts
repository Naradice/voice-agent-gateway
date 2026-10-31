// 接続情報の表示。  npm run gateway:code [-- --check] [-- --device pixel]
//   既定: 接続先・確認コード・接続コードを表示する(接続コードにはトークンが含まれる)。
//   --check: トークンを含まない情報だけ(確認コードと接続先)を表示する。画面共有やスクリーンショット向け。
import { checkHost, parseDevices } from "./config.ts";
import { connectionCode, tokenFingerprint } from "./connection.ts";
import { loadDotEnv, shadowedMessage } from "./env.ts";

const shadow = shadowedMessage(loadDotEnv());
if (shadow) console.warn(`警告: ${shadow}\n`);
const args = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

const devices = parseDevices(process.env.VAG_DEVICES);
const device = arg("device") ? devices.find((d) => d.deviceId === arg("device")) : devices[0];
if (!device) { console.error(`デバイス ${arg("device")} がありません。登録済み: ${devices.map((d) => d.deviceId).join(", ")}`); process.exit(1); }

const host = checkHost(process.env.VAG_HOST ?? "127.0.0.1");
const port = Number(process.env.VAG_PORT ?? 8787);

console.log(`デバイス: ${device.deviceId}`);
console.log(`接続先:   ws://${host}:${port}`);
console.log(`確認コード: ${tokenFingerprint(device.token)}   (アプリの設定画面に出る確認コードと同じなら、トークンの入力は正しい)`);
if (!args.includes("--check")) {
  console.log("\n接続コード(スマホにコピーして、アプリの「接続コードを貼り付け」で設定できる):");
  console.log(connectionCode(host, port, device.token));
  console.log("\nこのコードにはトークンが含まれる。チャットやリポジトリには貼らないこと。");
}
