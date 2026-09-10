import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { replyAsksUser, assistantReplyText } = await jiti.import("./reply-question.ts");

// The bug this guards: omp's todo reminder only reads the reply's LAST line
// before auto-continuing, so a question anywhere earlier is overridden and the
// agent proceeds as if the user had answered.

test("a question mid-reply followed by a summary line still asks the user", () => {
  const reply = [
    "I found two candidate configs.",
    "",
    "Which one should I migrate first?",
    "",
    "Summary: both are reachable; nothing changed yet.",
  ].join("\n");
  assert.equal(replyAsksUser(reply), true);
});

test("a question on the last line asks the user", () => {
  assert.equal(replyAsksUser("Done with the first pass.\nDo you want me to continue with the tests?"), true);
});

test("a CJK question asks the user", () => {
  assert.equal(replyAsksUser("設定を確認しました。\n次はどのファイルを変更しますか？"), true);
});

test("a TypeScript optional-property line is code, not a question", () => {
  assert.equal(replyAsksUser("Added the field:\n  retries?: number\nto the options interface."), false);
});

test("a plain statement reply asks nothing", () => {
  assert.equal(replyAsksUser("Migrated both callers and removed the shim.\nAll three locale files updated."), false);
});

test("a question inside a fenced code block is ignored", () => {
  const reply = [
    "Here is the prompt template:",
    "```",
    "What would you like to do next?",
    "```",
    "Wired it into the CLI.",
  ].join("\n");
  assert.equal(replyAsksUser(reply), false);
});

test("a question inside a bullet asks the user", () => {
  assert.equal(replyAsksUser("Open decisions:\n- Which do you prefer: A or B?\n- Nothing else blocks."), true);
});

test("a response cue without a question mark asks the user", () => {
  assert.equal(replyAsksUser("Two options are viable.\nPlease confirm before I delete the old table."), true);
});

test("a URL carrying a query string is not a question", () => {
  assert.equal(replyAsksUser("Preview: http://localhost:3000/?tab=logs\nThe page renders."), false);
});

test("assistantReplyText reads only assistant message_end text blocks", () => {
  const frame = {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "should I ask?" },
        { type: "text", text: "Which branch?" },
        { type: "toolCall", id: "t1", name: "read" },
        { type: "text", text: "Reading now." },
      ],
    },
  };
  assert.equal(assistantReplyText(frame), "Which branch?\nReading now.");
  assert.equal(assistantReplyText({ type: "message_end", message: { role: "user", content: "hi?" } }), null);
  assert.equal(assistantReplyText({ type: "agent_end" }), null);
});
