import { test } from "node:test";
import assert from "node:assert";
import { splitMarkdownReveal, splitPlainReveal } from "./stream-reveal-split.ts";

test("splitMarkdownReveal - prefix-only when fence unclosed", () => {
  const text = "Here is code:\n```typescript\nconst x = 1;";
  const { prefix, tail } = splitMarkdownReveal(text);
  assert.equal(tail, "");
  assert.equal(prefix, text);
});

test("splitMarkdownReveal - preserves closed fence in prefix", () => {
  const text = "```\ncode\n```\ntext";
  const { prefix, tail } = splitMarkdownReveal(text);
  assert.equal(prefix, "```\ncode\n```\n");
  assert.equal(tail, "text");
});

test("splitMarkdownReveal - live tail is current line", () => {
  const text = "Paragraph one\nParagraph two in flight";
  const { prefix, tail } = splitMarkdownReveal(text);
  assert.equal(prefix, "Paragraph one\n");
  assert.equal(tail, "Paragraph two in flight");
});

test("splitMarkdownReveal - detects paragraph gap (double newline)", () => {
  const text = "Para 1\n\nPara 2 start";
  const { prefix, tail, paragraphGap } = splitMarkdownReveal(text);
  assert.equal(prefix, "Para 1\n\n");
  assert.equal(tail, "Para 2 start");
  assert.equal(paragraphGap, true);
});

test("splitMarkdownReveal - no paragraph gap for single newline", () => {
  const text = "Line 1\nLine 2 start";
  const { paragraphGap } = splitMarkdownReveal(text);
  assert.equal(paragraphGap, false);
});

test("splitMarkdownReveal - tilde fences", () => {
  const text = "~~~\ncode\n~~~\ntext";
  const { tail } = splitMarkdownReveal(text);
  assert.equal(tail, "text");
});

test("splitPlainReveal - returns all text if under window", () => {
  const text = "short";
  const { prefix, tail } = splitPlainReveal(text, 100);
  assert.equal(prefix, "");
  assert.equal(tail, "short");
});

test("splitPlainReveal - snaps to word boundary", () => {
  const text = "word one word two";
  const { prefix, tail } = splitPlainReveal(text, 5);
  // Window is 5 chars from end; text is 17, so start at 12. Char 12 is space
  // before "two", so snap forward to 13 ("t" of "two").
  assert(tail.startsWith("t") || tail.startsWith("two"));
});

test("splitPlainReveal - handles empty text", () => {
  const text = "";
  const { prefix, tail } = splitPlainReveal(text);
  assert.equal(prefix, "");
  assert.equal(tail, "");
});
