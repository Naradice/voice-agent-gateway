import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { loadDotEnv, shadowedMessage } from "../src/env.ts";
import { connectionCode, tokenFingerprint } from "../src/connection.ts";
import { buildEnvFile, newToken } from "../src/init.ts";

test("buildEnvFile output parses back to the same device list and a long random token", () => {
  const token = newToken();
  assert.ok(token.length >= 40);
  assert.notEqual(token, newToken());
  const env = parseEnv(buildEnvFile({ deviceId: "pixel", token, host: "100.1.2.3", port: 9000 }));
  assert.deepEqual(JSON.parse(env.VAG_DEVICES!), [{ deviceId: "pixel", token }]);
  assert.equal(env.VAG_HOST, "100.1.2.3");
  assert.equal(env.VAG_PORT, "9000");
  assert.equal(env.LOCAL_MODEL, "qwen3:14b");
  assert.equal(env.SEARCH_PROVIDER, undefined, "任意の設定はコメントアウトされている");
});

test("loadDotEnv reads a file, never overrides real environment variables, and tolerates a missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "vag-env-"));
  const file = join(dir, ".env");
  writeFileSync(file, `VAG_TEST_NEW=from-file\nVAG_TEST_EXISTING=from-file\nVAG_TEST_JSON='[{"a":"b"}]'\n`);
  process.env.VAG_TEST_EXISTING = "from-shell";
  try {
    const r = loadDotEnv(file);
    assert.equal(r.loaded, true);
    assert.deepEqual(r.shadowed, ["VAG_TEST_EXISTING"], "環境変数に上書きされた設定が分かる");
    assert.match(shadowedMessage(r)!, /VAG_TEST_EXISTING/);
    assert.equal(process.env.VAG_TEST_NEW, "from-file");
    assert.equal(process.env.VAG_TEST_EXISTING, "from-shell");
    assert.equal(process.env.VAG_TEST_JSON, '[{"a":"b"}]');
    assert.equal(loadDotEnv(join(dir, "missing.env")).loaded, false);
    assert.equal(shadowedMessage(loadDotEnv(join(dir, "missing.env"))), undefined);
  } finally {
    for (const k of ["VAG_TEST_NEW", "VAG_TEST_EXISTING", "VAG_TEST_JSON"]) delete process.env[k];
  }
});

test("gateway:init writes a private .env once and refuses to overwrite it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vag-init-"));
  const file = join(dir, ".env");
  const { spawnSync } = await import("node:child_process");
  const run = () => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", new URL("../src/init.ts", import.meta.url).pathname, "--host", "127.0.0.1"], { env: { ...process.env, VAG_ENV_FILE: file }, encoding: "utf8" });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.ok(existsSync(file));
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o077, 0, "他のユーザーから読めない");
  const token = JSON.parse(parseEnv(readFileSync(file, "utf8")).VAG_DEVICES!)[0].token;
  assert.ok(first.stdout.includes(token), "初回だけ画面にトークンを表示する");
  const second = run();
  assert.notEqual(second.status, 0);
  assert.ok(!second.stdout.includes(token) && !second.stderr.includes(token));
  assert.equal(JSON.parse(parseEnv(readFileSync(file, "utf8")).VAG_DEVICES!)[0].token, token, "上書きされていない");
});

test("the token fingerprint is 6 hex chars, ignores surrounding whitespace, and matches the Android implementation's test vector", () => {
  assert.match(tokenFingerprint("any-token-0123456789abcdef"), /^[0-9a-f]{6}$/);
  assert.equal(tokenFingerprint("  spaced-token-0123456789  "), tokenFingerprint("spaced-token-0123456789"));
  assert.notEqual(tokenFingerprint("token-A-0123456789abcdef"), tokenFingerprint("token-B-0123456789abcdef"));
  // Kotlin 側(core の FingerprintTest)と同じ値。どちらかを変えたら、もう一方も変えること。
  assert.equal(tokenFingerprint("test-token-for-fingerprint"), "4d1986");
});

test("connectionCode has the url and token joined by #", () => {
  assert.equal(connectionCode("100.1.2.3", 8787, "abc"), "ws://100.1.2.3:8787#abc");
});
