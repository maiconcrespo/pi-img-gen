/**
 * Prompt text layout for the overlay textarea.
 *
 * Rows carry UTF-16 start/end indices into the original prompt so the caret
 * (and therefore CURSOR_MARKER) can be placed on the exact rendered row.
 * Measurement is injected: the overlay passes pi-tui's `visibleWidth()` so
 * wide/emoji/combining characters count real terminal columns (tui.md: "Use
 * visibleWidth() … instead of implementing terminal-width handling yourself");
 * the default measure keeps this module dependency-free and unit-testable.
 */

/** One rendered line of the prompt plus its UTF-16 range in the source text. */
export interface PromptRow {
  text: string;
  /** Index of the first character of this row. */
  start: number;
  /** Index just past the last character of this row (never includes a `\n`). */
  end: number;
}

/** Default column measure: ASCII ≈ 1 column, CJK/emoji ≈ 2, combining marks ≈ 0. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;
    if (
      (cp >= 0x0300 && cp <= 0x036f) || // combining diacritics
      (cp >= 0x200b && cp <= 0x200f) || // zero-width space/joiners/marks
      (cp >= 0x2060 && cp <= 0x2064) || // word joiner etc.
      (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
      (cp >= 0xfe20 && cp <= 0xfe2f) // combining half marks
    ) {
      continue;
    }
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/**
 * Wrap `text` into rows of at most `width` columns. Hard newlines always start
 * a new row; long words soft-wrap at the column limit.
 */
export function wrapRows(text: string, width: number, measure: (value: string) => number = displayWidth): PromptRow[] {
  const limit = Math.max(1, Math.floor(width));
  const rows: PromptRow[] = [];

  let lineStart = 0;
  while (true) {
    const newline = text.indexOf("\n", lineStart);
    const line = newline === -1 ? text.slice(lineStart) : text.slice(lineStart, newline);
    pushWrappedLine(rows, line, lineStart, limit, measure);
    if (newline === -1) break;
    lineStart = newline + 1;
  }

  if (rows.length === 0) rows.push({ text: "", start: 0, end: 0 });
  return rows;
}

function pushWrappedLine(
  rows: PromptRow[],
  line: string,
  lineStart: number,
  limit: number,
  measure: (value: string) => number,
): void {
  if (line.length === 0) {
    rows.push({ text: "", start: lineStart, end: lineStart });
    return;
  }

  let rowStart = 0;
  let offset = 0;
  let acc = "";
  let accWidth = 0;

  for (const cp of line) {
    const cpWidth = measure(cp);
    if (acc.length > 0 && accWidth + cpWidth > limit) {
      rows.push({ text: acc, start: lineStart + rowStart, end: lineStart + offset });
      rowStart = offset;
      acc = "";
      accWidth = 0;
    }
    acc += cp;
    accWidth += cpWidth;
    offset += cp.length;
  }
  rows.push({ text: acc, start: lineStart + rowStart, end: lineStart + offset });
}

/**
 * Row index that should carry the caret for a cursor position.
 *
 * - a soft-wrap boundary belongs to the next row (the caret precedes that
 *   row's first character),
 * - a hard newline belongs to the row it terminates,
 * - out-of-range cursors fall back to the last row.
 */
export function rowIndexForCursor(rows: readonly PromptRow[], cursor: number): number {
  if (rows.length === 0) return 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (cursor <= row.end) {
      const next = rows[i + 1];
      if (cursor === row.end && next !== undefined && next.start === cursor) return i + 1;
      return i;
    }
  }
  return rows.length - 1;
}

/** Index of the first character of the line containing `cursor`. */
export function lineStartAt(text: string, cursor: number): number {
  return text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
}

/** Index just past the last character of the line containing `cursor`. */
export function lineEndAt(text: string, cursor: number): number {
  const newline = text.indexOf("\n", cursor);
  return newline === -1 ? text.length : newline;
}

/** Move `cursor` to the start of the code point before it. */
export function previousIndex(text: string, cursor: number): number {
  if (cursor <= 0) return 0;
  const cp = text.codePointAt(cursor - 1);
  if (cp !== undefined && cp >= 0xdc00 && cp <= 0xdfff) return Math.max(0, cursor - 2);
  return cursor - 1;
}

/** Move `cursor` past the code point at it. */
export function nextIndex(text: string, cursor: number): number {
  if (cursor >= text.length) return text.length;
  const cp = text.codePointAt(cursor);
  return cursor + (cp !== undefined && cp > 0xffff ? 2 : 1);
}
