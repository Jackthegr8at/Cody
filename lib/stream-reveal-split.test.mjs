import { test } from "node:test";
import assert from "node:assert/strict";
import { splitMarkdownReveal } from "./stream-reveal-split.ts";

test("the tail is the block in flight; a single newline never cuts", () => {
  assert.deepEqual(splitMarkdownReveal("Paragraph one\nstill the same paragraph"), { prefix: "", tail: "Paragraph one\nstill the same paragraph" });
});

test("a blank line commits every block before it", () => {
  assert.deepEqual(splitMarkdownReveal("Para 1\n\nPara 2 in flight"), { prefix: "Para 1\n\n", tail: "Para 2 in flight" });
  assert.deepEqual(splitMarkdownReveal("- a\n- b\n\n- c\n- d being typed"), { prefix: "- a\n- b\n\n", tail: "- c\n- d being typed" });
});

test("blank lines inside a fence do not cut, and an unclosed fence stays live", () => {
  const text = "Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;";
  assert.deepEqual(splitMarkdownReveal(text), { prefix: "Intro\n\n", tail: "```ts\nconst a = 1;\n\nconst b = 2;" });
  const closed = `${text}\n\`\`\`\n\nAfter`;
  assert.deepEqual(splitMarkdownReveal(closed), { prefix: "Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n", tail: "After" });
});

test("a fence of one kind is not closed by the other", () => {
  assert.equal(splitMarkdownReveal("```\ncode\n~~~\n\nmore").prefix, "");
});

test("the committed prefix never moves: it only grows as blocks close", () => {
  const stream = "# Title\n\nFirst para.\n\n- one\n- two\n\nLast para typing";
  let previous = "";
  for (let i = 1; i <= stream.length; i++) {
    const { prefix } = splitMarkdownReveal(stream.slice(0, i));
    assert.ok(prefix.startsWith(previous), `prefix regressed at ${i}`);
    previous = prefix;
  }
  assert.equal(previous, "# Title\n\nFirst para.\n\n- one\n- two\n\n");
});
