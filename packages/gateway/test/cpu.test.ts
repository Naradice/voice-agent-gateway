import { test } from "node:test";
import assert from "node:assert/strict";
import { CPU_OLLAMA_PORT, cpuOnlyEnv, deviceVerdict, portOf } from "../src/local/cpu.ts";

test("cpuOnlyEnv hides every GPU, binds to localhost only, and limits memory use; it keeps the rest of the environment", () => {
  const env = cpuOnlyEnv({ PATH: "/bin", OLLAMA_HOST: "0.0.0.0:11434", CUDA_VISIBLE_DEVICES: "0" }, 11435);
  assert.equal(env.CUDA_VISIBLE_DEVICES, "-1");
  assert.equal(env.ROCR_VISIBLE_DEVICES, "-1");
  assert.equal(env.HIP_VISIBLE_DEVICES, "-1");
  assert.equal(env.OLLAMA_HOST, "127.0.0.1:11435", "外部に公開しない・普段使いの設定を引き継がない");
  assert.equal(env.OLLAMA_NUM_PARALLEL, "1");
  assert.equal(env.OLLAMA_MAX_LOADED_MODELS, "1");
  assert.equal(env.PATH, "/bin");
});

test("portOf reads the port of OLLAMA_BASE_URL and falls back for missing or invalid values", () => {
  assert.equal(portOf("http://127.0.0.1:11435/v1"), 11435);
  assert.equal(portOf("http://localhost:9999"), 9999);
  assert.equal(portOf(undefined), CPU_OLLAMA_PORT);
  assert.equal(portOf("not a url"), CPU_OLLAMA_PORT);
  assert.equal(portOf("http://127.0.0.1/v1"), CPU_OLLAMA_PORT, "ポートの指定がなければ fallback");
});

test("deviceVerdict: a CPU-only setup must show no VRAM; any GPU use is flagged with how to fix it", () => {
  const GB = 1024 ** 3;
  const cpu = { loaded: true, sizeBytes: 2.6 * GB, vramBytes: 0, gpuFraction: 0 };
  const gpu = { loaded: true, sizeBytes: 9.3 * GB, vramBytes: 9.3 * GB, gpuFraction: 1 };
  const part = { loaded: true, sizeBytes: 9.3 * GB, vramBytes: 4 * GB, gpuFraction: 0.43 };

  assert.equal(deviceVerdict(cpu, "cpu").ok, true);
  assert.match(deviceVerdict(cpu, "cpu").message, /CPU のみ/);
  const bad = deviceVerdict(gpu, "cpu");
  assert.equal(bad.ok, false);
  assert.match(bad.message, /GPU を使っています.*npm run ollama:cpu/);
  assert.equal(deviceVerdict(part, "cpu").ok, false, "一部でも GPU を使えば NG");

  assert.equal(deviceVerdict(gpu, "gpu").ok, true);
  assert.equal(deviceVerdict(part, "gpu").ok, false);
  assert.equal(deviceVerdict({ loaded: false }, "cpu").ok, true);
});
