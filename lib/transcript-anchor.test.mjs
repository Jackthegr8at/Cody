import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { selectAnchorBox, anchorIsInsideOpenBlock } = await jiti.import("./transcript-anchor.ts");

test("the box containing the edge is the anchor, and the innermost one wins", () => {
  // Document order: a group row, then its two inner rows (descendants come after ancestors).
  const group = { top: -400, bottom: 600, name: "group" };
  const inner1 = { top: -400, bottom: -50, name: "inner1" };
  const inner2 = { top: -50, bottom: 600, name: "inner2" };
  assert.equal(selectAnchorBox([group, inner1, inner2], 0)?.name, "inner2");
});

test("an edge in a gap between rows anchors on the next row below it", () => {
  const above = { top: -300, bottom: -20, name: "above" };
  const below = { top: 12, bottom: 400, name: "below" };
  const further = { top: 400, bottom: 800, name: "further" };
  assert.equal(selectAnchorBox([above, below, further], 0)?.name, "below");
});

test("an edge above every box anchors on the first box; below every box there is no anchor", () => {
  const rows = [{ top: 30, bottom: 100, name: "first" }, { top: 100, bottom: 200, name: "second" }];
  assert.equal(selectAnchorBox(rows, 0)?.name, "first");
  assert.equal(selectAnchorBox(rows, 250), null);
  assert.equal(selectAnchorBox([], 0), null);
});

test("a box whose bottom sits exactly on the edge does not contain it", () => {
  const touching = { top: -100, bottom: 0, name: "touching" };
  const next = { top: 0, bottom: 100, name: "next" };
  assert.equal(selectAnchorBox([touching, next], 0)?.name, "next");
});

test("a thinking box is only kept open when the anchor names it and it was open", () => {
  const openBox = { turnIndex: 4, part: null, blockIndex: 1, offset: -120, turnOffset: -300, height: 480 };
  assert.equal(anchorIsInsideOpenBlock(openBox, 4, 1, 48), true, "the reader's edge is inside an open box");
  assert.equal(anchorIsInsideOpenBlock({ ...openBox, height: 32 }, 4, 1, 48), false, "a header-only box was collapsed");
  assert.equal(anchorIsInsideOpenBlock(openBox, 4, 2, 48), false, "another block of the same message");
  assert.equal(anchorIsInsideOpenBlock(openBox, 5, 1, 48), false, "another message");
  assert.equal(anchorIsInsideOpenBlock(null, 4, 1, 48), false, "a follower has no anchor");
});
