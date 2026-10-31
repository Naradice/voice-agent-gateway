import type { DeviceCredential } from "./server.ts";

export const fail = (msg: string): never => {
  console.error(`起動できません: ${msg}`);
  process.exit(1);
};

export function parseDevices(raw: string | undefined): DeviceCredential[] {
  if (!raw) return fail("VAG_DEVICES が未設定です(npm run gateway:init で .env を作れます)");
  let list: unknown;
  try { list = JSON.parse(raw); } catch { return fail("VAG_DEVICES が JSON ではありません"); }
  if (!Array.isArray(list) || list.length === 0) return fail("VAG_DEVICES は1件以上の配列にしてください");
  return list.map((d: any) => {
    if (typeof d?.deviceId !== "string" || !/^[\w-]{1,32}$/.test(d.deviceId)) return fail("deviceId は英数字・_・- で32文字以内にしてください");
    if (typeof d?.token !== "string" || d.token.length < 24) return fail(`デバイス ${d.deviceId} のトークンが短すぎます(24文字以上)`);
    return { deviceId: d.deviceId, token: d.token };
  });
}

/** 全インターフェースでの待ち受けは、明示しない限り拒否する(設計書 §9.1)。 */
export function checkHost(host: string): string {
  if (["0.0.0.0", "::", ""].includes(host) && process.env.VAG_ALLOW_ANY_HOST !== "1") {
    return fail("全インターフェースでの待ち受けは既定で拒否します。Tailscale の IP を VAG_HOST に指定してください");
  }
  return host;
}

export const jsonLog = (level: "info" | "warn" | "error", msg: string, meta: object = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...meta }));
