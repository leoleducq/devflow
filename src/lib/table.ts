import { colors } from "./colors.js";

/**
 * Aligned columnar output, hand-rolled.
 *
 * Every table DevFlow prints is a handful of short rows of plain ASCII, which
 * is the case a table library is least worth its weight for: cli-table3 and
 * friends bring box-drawing, wrapping and a dependency, to solve a padding
 * problem that is four lines of code. What they *would* buy — correct widths
 * for wide characters — does not apply to branch names, ports and tool
 * versions.
 *
 * The one thing that genuinely needs care is colour: a cell that has been
 * painted carries escape sequences that `padEnd` counts as visible width, so
 * every column would drift by exactly the length of the codes. Widths are
 * therefore measured on the stripped text and the padding applied separately.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;

/** Visible width of a cell, ignoring any colour codes inside it. */
export const visibleWidth = (text: string): number =>
  text.replace(ANSI, "").length;

/** Pad to `width` visible characters, whatever escape codes it contains. */
export const padCell = (text: string, width: number): string =>
  text + " ".repeat(Math.max(0, width - visibleWidth(text)));

export type Column = {
  /** Heading, omitted from the output when no column has one. */
  header?: string;
  /** Right-align instead of left; for ports and counts. */
  align?: "left" | "right";
};

/**
 * Render rows as aligned columns.
 *
 * The last column is never padded — trailing whitespace on every line is
 * invisible until someone selects the text or diffs the output.
 */
export function table(
  rows: string[][],
  options: { columns?: Column[]; indent?: string; gap?: string } = {},
): string[] {
  if (rows.length === 0) return [];
  const { columns = [], indent = "", gap = "  " } = options;

  const headers = columns.map(c => c.header).filter(Boolean) as string[];
  const body =
    headers.length > 0
      ? [columns.map(c => colors.bold(c.header ?? "")), ...rows]
      : rows;

  const count = Math.max(...body.map(row => row.length));
  const widths = Array.from({ length: count }, (_, i) =>
    Math.max(...body.map(row => visibleWidth(row[i] ?? ""))),
  );

  return body.map(row =>
    (
      indent +
      row
        .map((cell, i) => {
          const isLast = i === row.length - 1;
          if (isLast) return columns[i]?.align === "right"
            ? " ".repeat(Math.max(0, widths[i]! - visibleWidth(cell))) + cell
            : cell;
          return columns[i]?.align === "right"
            ? " ".repeat(Math.max(0, widths[i]! - visibleWidth(cell))) + cell
            : padCell(cell, widths[i]!);
        })
        .join(gap)
    ).trimEnd(),
  );
}

/** Print what `table` renders. */
export const printTable = (
  rows: string[][],
  options?: { columns?: Column[]; indent?: string; gap?: string },
): void => {
  for (const line of table(rows, options)) console.log(line);
};

/**
 * A label/value block — `doctor`'s check list, `project get`'s settings.
 * Same alignment problem, but two columns and no heading.
 */
export const printPairs = (
  pairs: Array<[string, string]>,
  options: { indent?: string } = {},
): void => {
  printTable(
    pairs.map(([label, value]) => [colors.bold(label), value]),
    { indent: options.indent ?? "" },
  );
};
