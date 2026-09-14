import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * These bounds are what make the sidebar usable on the owner's P40 models
 * rather than hosted-only. The cases below are the real served windows from
 * models.yml, so a regression here means a local model's turn fails outright
 * instead of paging.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { CHARS_PER_TOKEN, clampForSidebar, resultCharBudget, resultTokenBudget } =
  await jiti.import("./sidebar-context-budget.ts");

test("a result never eats the window it has to share", () => {
  // qwen3.5-4b: 8,192 window, 2,048 output -> 6,144 usable.
  const budget = resultTokenBudget(8192, 2048);
  assert.ok(budget <= 6144 * 0.25 + 1, `one result took ${budget} of 6,144 usable`);
  // Several reads plus the conversation must still fit.
  assert.ok(budget * 3 < 6144, `three reads (${budget * 3}) exceeded the usable window`);
  // ...and it must still be worth reading.
  assert.ok(budget >= 300, `budget ${budget} is too small to be useful`);
});

test("every real P40 window gets a bigger budget than the one below it", () => {
  const windows = [
    { window: 8192, maxTokens: 2048 },
    { window: 16384, maxTokens: 4096 },
    { window: 24576, maxTokens: 8192 },
  ];
  const budgets = windows.map((w) => resultTokenBudget(w.window, w.maxTokens));
  for (let i = 1; i < budgets.length; i++) {
    assert.ok(budgets[i] > budgets[i - 1], `window ${windows[i].window} did not grow the budget`);
  }
});

test("an unknown window is treated as the smallest, never as unlimited", () => {
  // Guessing large is how a small model receives a result it cannot fit.
  assert.equal(resultTokenBudget(undefined), resultTokenBudget(8192));
  assert.equal(resultTokenBudget(0), resultTokenBudget(8192));
  assert.ok(resultTokenBudget(undefined) < resultTokenBudget(200_000));
});

test("char budget tracks the token budget", () => {
  assert.equal(resultCharBudget(8192, 2048), resultTokenBudget(8192, 2048) * CHARS_PER_TOKEN);
});

test("paging walks the whole text exactly once, in order", () => {
  const body = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
  let offset = 0;
  let rebuilt = "";
  let pages = 0;
  for (;;) {
    const page = clampForSidebar(body, 500, { offset });
    rebuilt += page.text;
    pages += 1;
    if (!page.truncated) break;
    assert.equal(typeof page.nextOffset, "number");
    assert.ok(page.nextOffset > offset, "nextOffset must advance or paging loops forever");
    offset = page.nextOffset;
    assert.ok(pages < 100, "paging did not terminate");
  }
  assert.ok(pages > 1, "the fixture should need more than one page");
  assert.equal(rebuilt, body, "paged reads must reconstruct the original exactly");
});

test("truncation is always reported, and the end is not", () => {
  const short = clampForSidebar("tiny", 4000);
  assert.equal(short.truncated, false);
  assert.equal(short.nextOffset, null);

  const long = clampForSidebar("x".repeat(9000), 4000);
  assert.equal(long.truncated, true);
  assert.equal(long.nextOffset, 4000);
});

test("a slice ends on a line boundary when one is near the cut", () => {
  const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const page = clampForSidebar(body, 300);
  assert.ok(page.text.endsWith("\n"), "a paged slice should not split a line");
});

test("a single unbroken line still makes progress", () => {
  // A minified file has no break to cut on; it must not stall at zero bytes.
  const page = clampForSidebar("y".repeat(5000), 1000);
  assert.equal(page.text.length, 1000);
  assert.equal(page.nextOffset, 1000);
});

test("an offset past the end terminates instead of looping", () => {
  const page = clampForSidebar("abc", 100, { offset: 99 });
  assert.equal(page.text, "");
  assert.equal(page.truncated, false);
  assert.equal(page.nextOffset, null);
});
