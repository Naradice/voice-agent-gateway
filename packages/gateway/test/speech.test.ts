import { test } from "node:test";
import assert from "node:assert/strict";
import { SentenceStream, cleanMarkdown, formatForSpeech } from "../src/speech.ts";

test("markdown is stripped and URLs are not read aloud", () => {
  assert.equal(cleanMarkdown("## 見出し"), "見出し");
  assert.equal(cleanMarkdown("**重要**な[資料](https://example.com/a)を見て"), "重要な資料を見て");
  assert.equal(cleanMarkdown("詳細は https://example.com/very/long/path?x=1 にあります"), "詳細は リンク にあります");
  assert.equal(cleanMarkdown("- 一つ目\n- 二つ目"), "一つ目\n二つ目");
});

test("code blocks are replaced by a single note, including an unclosed block", () => {
  const t = formatForSpeech("実装はこうです。\n```ts\nconst a = 1;\n```\n以上です。");
  assert.equal(t, "実装はこうです。コードは省略します。以上です。");
  assert.equal(formatForSpeech("見てください。\n```py\nprint(1)"), "見てください。コードは省略します。");
});

test("long text is cut at a sentence boundary with an omission notice", () => {
  const text = "これは一文目です。".repeat(50);
  const out = formatForSpeech(text, { maxChars: 40 });
  assert.ok(out.endsWith("以降は省略します。"));
  assert.ok(out.replace("以降は省略します。", "").endsWith("。"));
  assert.ok(out.length <= 40 + "以降は省略します。".length);
});

test("SentenceStream emits complete sentences as deltas arrive and flushes the tail", () => {
  const s = new SentenceStream();
  assert.deepEqual(s.push("こんに"), []);
  assert.deepEqual(s.push("ちは。元気"), ["こんにちは。"]);
  assert.deepEqual(s.push("ですか？はい"), ["元気ですか？"]);
  assert.deepEqual(s.flush(), ["はい。"]);
  assert.deepEqual(s.flush(), []);
});

test("SentenceStream skips code fences even when ``` is split across deltas, announcing once", () => {
  const s = new SentenceStream();
  const out: string[] = [];
  for (const d of ["説明です。``", "`py\nprint(1)\n", "x = 2\n`", "``\n終わりです。"]) out.push(...s.push(d));
  out.push(...s.flush());
  assert.deepEqual(out, ["説明です。", "コードは省略します。", "終わりです。"]);
});

test("SentenceStream cleans markdown per sentence and drops an unfinished fence at the end", () => {
  const s = new SentenceStream();
  assert.deepEqual(s.push("**大事**です。詳細は https://x.example/a を参照。"), ["大事です。", "詳細は リンク を参照。"]);
  s.push("```js\nconsole.log(1)");
  assert.deepEqual(s.flush(), []);
});
