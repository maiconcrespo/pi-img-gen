/**
 * Prompt-text wrapping and cursor→row mapping (src/textlayout.ts).
 *
 * Deterministic logic behind the overlay textarea: rows carry UTF-16 start/end
 * indices so the CURSOR_MARKER lands on the correct rendered row.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { displayWidth, rowIndexForCursor, wrapRows } from "../src/textlayout.ts";

test("ascii text wraps at the requested width with index ranges", () => {
  const rows = wrapRows("abcdef", 3);
  assert.deepEqual(
    rows.map((row) => row.text),
    ["abc", "def"],
  );
  assert.deepEqual(
    rows.map((row) => [row.start, row.end]),
    [
      [0, 3],
      [3, 6],
    ],
  );
});

test("hard newlines start a new row and the newline is not part of any row", () => {
  const rows = wrapRows("ab\ncd", 10);
  assert.deepEqual(
    rows.map((row) => row.text),
    ["ab", "cd"],
  );
  assert.deepEqual(
    rows.map((row) => [row.start, row.end]),
    [
      [0, 2],
      [3, 5],
    ],
  );
});

test("empty text is one empty row", () => {
  const rows = wrapRows("", 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, "");
  assert.equal(rowIndexForCursor(rows, 0), 0);
});

test("widths below 1 do not loop forever", () => {
  const rows = wrapRows("abc", 0);
  assert.ok(rows.length >= 1);
  assert.equal(
    rows.map((row) => row.text).join(""),
    "abc",
  );
});

test("wide characters consume two columns when measuring", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("猫"), 2);
  assert.equal(displayWidth("🐱"), 2);
  // "e" + combining acute accent renders as one column.
  assert.equal(displayWidth("é"), 1);
  const rows = wrapRows("猫猫猫", 4, displayWidth);
  assert.deepEqual(
    rows.map((row) => row.text),
    ["猫猫", "猫"],
  );
});

test("cursor before the wrap point stays on the first row", () => {
  const rows = wrapRows("abcd", 2);
  assert.equal(rowIndexForCursor(rows, 1), 0);
  assert.equal(rowIndexForCursor(rows, 2), 1, "soft wrap: the caret precedes the next row's first char");
});

test("cursor at a hard newline stays on the line it terminates", () => {
  const rows = wrapRows("ab\ncd", 10);
  assert.equal(rowIndexForCursor(rows, 2), 0);
  assert.equal(rowIndexForCursor(rows, 3), 1);
});

test("cursor at the very end maps to the last row", () => {
  const rows = wrapRows("abcd", 2);
  assert.equal(rowIndexForCursor(rows, 4), 1);
});

test("cursor beyond the text falls back to the last row", () => {
  const rows = wrapRows("ab", 10);
  assert.equal(rowIndexForCursor(rows, 99), 0);
});
