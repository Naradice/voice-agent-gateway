import { test } from "node:test";
import assert from "node:assert/strict";
import { CPU_OLLAMA_PORT, cpuModelName, cpuModelfile, cpuOnlyEnv, detectGpuInLog, deviceVerdict, portOf } from "../src/local/cpu.ts";

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

test("detectGpuInLog recognises GPU and CPU-only startup lines in the formats of different Ollama versions", () => {
  const cuda = 'time=2026-10-31T10:00:00 level=INFO source=types.go:131 msg="inference compute" id=GPU-1234 library=CUDA compute=8.9 name=CUDA0 total="24.0 GiB"';
  const cudaOld = 'level=INFO source=gpu.go:217 msg="inference compute" id=GPU-abcd library=cuda variant=v12 compute=8.6 driver=12.4';
  const rocm = 'msg="inference compute" id=0 library=rocm compute=gfx1100 name=Radeon';
  const cpu = 'time=... level=INFO source=types.go:60 msg="inference compute" id=cpu library=cpu compute="" name=cpu description=cpu';
  assert.deepEqual(detectGpuInLog(cuda), { gpu: true, cpu: false, library: "cuda", device: "CUDA0" });
  assert.equal(detectGpuInLog(cudaOld).library, "cuda");
  assert.deepEqual(detectGpuInLog(rocm), { gpu: true, cpu: false, library: "rocm", device: "Radeon" });
  const vulkan = 'msg="inference compute" id=GPU-9 library=Vulkan name="AMD Radeon(TM) Graphics" total="4.0 GiB"';
  assert.equal(detectGpuInLog(vulkan).library, "vulkan", "CUDA 以外の経路で検出された場合も、バックエンド名が分かる");
  assert.equal(detectGpuInLog(vulkan).device, "AMD Radeon(TM) Graphics");
  assert.deepEqual(detectGpuInLog(cpu), { gpu: false, cpu: true });
  assert.deepEqual(detectGpuInLog("level=INFO msg=\"Listening on 127.0.0.1:11435\""), { gpu: false, cpu: false });
});

test("the CPU-only derived model is named predictably and offloads zero layers to the GPU", () => {
  assert.equal(cpuModelName("qwen3:4b"), "qwen3-4b-cpu");
  assert.equal(cpuModelName("qwen3-4b-cpu"), "qwen3-4b-cpu", "二重に -cpu を付けない");
  assert.equal(cpuModelName("library/qwen3:8b"), "library-qwen3-8b-cpu");
  assert.equal(cpuModelfile("qwen3:4b"), "FROM qwen3:4b\nPARAMETER num_gpu 0\nPARAMETER num_ctx 4096\n");
  assert.match(cpuModelfile("qwen3-4b-cpu", 2048), /^FROM qwen3-4b\n.*num_ctx 2048/s, "派生モデルから更に派生しない");
});
