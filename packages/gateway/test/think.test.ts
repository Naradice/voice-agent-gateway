import { test } from "node:test";
import assert from "node:assert/strict";
import { ThinkStripper } from "../src/local/think.ts";

const run = (parts: string[]) => {
  const s = new ThinkStripper();
  return parts.map((p) => s.push(p)).join("") + s.flush();
};

test("complete think blocks are removed wherever the tags are split", () => {
  assert.equal(run(["<think>考え</think>答え"]), "答え");
  assert.equal(run(["<thi", "nk>考え", "</th", "ink>答え"]), "答え");
  assert.equal(run(["前<think>考え</think>後"]), "前後");
});

test("a stray closing tag is removed (what Qwen3 emits under /no_think: an empty thinking block that was opened by the prompt)", () => {
  assert.equal(run(["\n</think>\n\n答え"]), "答え");
  assert.equal(run(["</th", "ink>答え"]), "答え");
  assert.equal(run(["答え</think>続き"]), "答え続き");
});

test("an opening tag at the very end, an unfinished block, and plain text behave sensibly", () => {
  assert.equal(run(["答え<th", "ink>消える"]), "答え", "思考の途中で終わったら捨てる");
  assert.equal(run(["ただの文章。<b>強調</b>"]), "ただの文章。<b>強調</b>", "タグに似たものは消さない");
  assert.equal(run(["a <th", "ing>"]), "a <thing>", "途中まで一致しても、タグでなければそのまま出す");
});
