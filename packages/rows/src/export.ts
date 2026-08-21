import { quoteSqlIdentifierIfNeeded } from "../../sql/src/text/identifiers.js";

/**
 * Writing rows out, in one place. The same shapes serve the clipboard, the preview a reader reads
 * before committing to an export, and the file the export writes — so what is previewed is what is
 * written, and copying a row out speaks the same tab-separated dialect as exporting it.
 *
 * A result reaches this module as plain values: a row is what the grid shows, cell by cell, with
 * null for a PostgreSQL NULL. Nothing here reads a payload, a policy or a query.
 */

/** The shapes a result can be written out in. */
export type DataViewExportFormat = "csv" | "tsv" | "json" | "sql" | "markdown";

/** What a NULL is written as, where the shape does not say it for itself. */
export type DataViewExportNull = "empty" | "null" | "backslash-n";

/** The shape a reader chose, and the things that differ within it. */
export interface DataViewExportChoice {
  format: DataViewExportFormat;
  /** A header line, for the shapes that can go without one. */
  header: boolean;
  /** What a NULL becomes. JSON, SQL and Markdown say it their own way and ignore this. */
  nullAs: DataViewExportNull;
  /** What separates the columns of a delimited line; CSV and TSV are its two presets. */
  delimiter: string;
  /** The table INSERT statements are written against. Without one there is nothing to insert into. */
  table?: string;
  /*
   * Whether a value a spreadsheet would run as a formula is prefixed so it stays text. A file is
   * opened by a spreadsheet, so it is; the clipboard is read back by this grid as often as by
   * anything else, and a prefix there would come back as part of the value.
   */
  spreadsheetSafe: boolean;
}

/** The choice a reader starts from: a CSV with a header, NULL left empty. */
export const DEFAULT_DATA_VIEW_EXPORT: DataViewExportChoice = {
  format: "csv",
  header: true,
  nullAs: "empty",
  delimiter: ",",
  spreadsheetSafe: true,
};

/** What the clipboard speaks: tab-separated, no header, and read back by this grid unchanged. */
export const CLIPBOARD_EXPORT: DataViewExportChoice = {
  format: "tsv",
  header: false,
  nullAs: "empty",
  delimiter: "\t",
  spreadsheetSafe: false,
};

/** The delimiter each delimited shape is written with, whatever the reader last chose. */
export function exportDelimiterFor(format: DataViewExportFormat, chosen: string): string {
  if (format === "tsv") return "\t";
  if (format === "csv") return chosen === "\t" ? "," : chosen;
  return chosen;
}

/** The extension a file of this shape is given. */
export function exportFileExtension(format: DataViewExportFormat): string {
  return format === "markdown" ? "md" : format;
}

/**
 * Whether a shape can be written one batch at a time. Markdown lines its columns up, which needs
 * every row measured before the first one is written, so a result too large to hold cannot take it.
 */
export function exportStreams(format: DataViewExportFormat): boolean {
  return format !== "markdown";
}

/** Writing a result out a piece at a time, which is what a result too large to hold needs. */
export interface DataViewExportWriter {
  /** What comes before the first row. */
  opening(): string;
  /** One row, ready to be written; empty when the shape puts nothing there. */
  row(values: readonly (string | null)[], index: number): string;
  /** What comes after the last row. */
  closing(): string;
}

export function dataViewExportWriter(
  columns: readonly string[],
  choice: DataViewExportChoice,
): DataViewExportWriter {
  if (choice.format === "json") return jsonWriter(columns);
  if (choice.format === "sql") return sqlWriter(columns, choice.table);
  if (choice.format === "markdown") {
    throw new Error(
      "A Markdown table lines its columns up, so it is written whole, not in pieces.",
    );
  }
  return delimitedWriter(columns, choice);
}

/**
 * A whole result, written out. Markdown reaches its columns' widths here, where every row is
 * already at hand; every other shape is the writer's pieces joined.
 */
export function dataViewExportText(
  columns: readonly string[],
  rows: readonly (readonly (string | null)[])[],
  choice: DataViewExportChoice,
): string {
  if (choice.format === "markdown") return markdownTable(columns, rows);
  const writer = dataViewExportWriter(columns, choice);
  return [writer.opening(), ...rows.map((row, index) => writer.row(row, index)), writer.closing()]
    .filter((piece) => piece !== "")
    .join("");
}

// --- The shapes ---------------------------------------------------------------------------------

function delimitedWriter(
  columns: readonly string[],
  choice: DataViewExportChoice,
): DataViewExportWriter {
  const delimiter = exportDelimiterFor(choice.format, choice.delimiter);
  const nothing = nullText(choice.nullAs);
  return {
    opening: () =>
      choice.header
        ? `${columns
            .map((name) => escapeDelimited(name, delimiter, choice.spreadsheetSafe))
            .join(delimiter)}\n`
        : "",
    row: (values) =>
      `${values
        .map((value) => escapeDelimited(value ?? nothing, delimiter, choice.spreadsheetSafe))
        .join(delimiter)}\n`,
    closing: () => "",
  };
}

function jsonWriter(columns: readonly string[]): DataViewExportWriter {
  return {
    opening: () => "[\n",
    row: (values, index) => {
      const record = Object.fromEntries(
        columns.map((name, column) => [name, values[column] ?? null]),
      );
      return `${index > 0 ? ",\n" : ""}  ${JSON.stringify(record)}`;
    },
    closing: () => "\n]\n",
  };
}

function sqlWriter(columns: readonly string[], table: string | undefined): DataViewExportWriter {
  if (!table) throw new Error("INSERT statements need a table to be written against.");
  const into = `INSERT INTO ${table} (${columns.map(quoteSqlIdentifierIfNeeded).join(", ")})`;
  return {
    opening: () => "",
    /*
     * Every value is written as a quoted literal, NULL apart. PostgreSQL reads an unadorned
     * literal as of unknown type and casts it to the column's, so a number, a date and a text all
     * go in the same way — and none of them can be mistaken for syntax.
     */
    row: (values) => `${into}\nVALUES (${values.map(sqlLiteral).join(", ")});\n`,
    closing: () => "",
  };
}

function markdownTable(
  columns: readonly string[],
  rows: readonly (readonly (string | null)[])[],
): string {
  // A NULL is written as nothing: a Markdown table has no way to say it, and an empty cell reads
  // as an empty cell in every reader.
  const cells = rows.map((row) => columns.map((_name, column) => markdownCell(row[column] ?? "")));
  const widths = columns.map((name, column) =>
    Math.max(markdownCell(name).length, 3, ...cells.map((row) => (row[column] ?? "").length)),
  );
  const line = (values: readonly string[]) =>
    `| ${values.map((value, column) => value.padEnd(widths[column] ?? 0)).join(" | ")} |\n`;
  return [
    line(columns.map(markdownCell)),
    `|${widths.map((width) => "-".repeat(width + 2)).join("|")}|\n`,
    ...cells.map(line),
  ].join("");
}

// --- Writing one value --------------------------------------------------------------------------

function nullText(nullAs: DataViewExportNull): string {
  if (nullAs === "null") return "NULL";
  return nullAs === "backslash-n" ? "\\N" : "";
}

/**
 * One value on a delimited line: quoted where the delimiter, a quote or a line break would
 * otherwise break the line apart, and prefixed where a spreadsheet would read it as a formula
 * rather than as text.
 */
function escapeDelimited(value: string, delimiter: string, neutralise: boolean): string {
  const text = neutralise && /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  if (!text.includes(delimiter) && !/["\r\n]/u.test(text)) return text;
  return `"${text.replace(/"/gu, '""')}"`;
}

/**
 * Reading delimited text back, which is what a paste is. A quoted field keeps the delimiters and
 * the line breaks inside it, and a doubled quote inside one is a single quote — so what this grid
 * wrote comes back as what it wrote.
 */
export function parseDelimitedText(text: string, delimiter: string): string[][] {
  const lines: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  let at = 0;
  const endValue = () => {
    row.push(value);
    value = "";
  };
  const endRow = () => {
    endValue();
    lines.push(row);
    row = [];
  };
  while (at < text.length) {
    const character = text[at] ?? "";
    if (quoted) {
      if (character === '"') {
        if (text[at + 1] === '"') {
          value += '"';
          at += 2;
          continue;
        }
        quoted = false;
        at += 1;
        continue;
      }
      value += character;
      at += 1;
      continue;
    }
    if (character === '"' && value === "") {
      quoted = true;
      at += 1;
      continue;
    }
    if (text.startsWith(delimiter, at)) {
      endValue();
      at += delimiter.length;
      continue;
    }
    if (character === "\n" || character === "\r") {
      endRow();
      at += character === "\r" && text[at + 1] === "\n" ? 2 : 1;
      continue;
    }
    value += character;
    at += 1;
  }
  if (value !== "" || row.length > 0) endRow();
  return lines;
}

function sqlLiteral(value: string | null): string {
  return value === null ? "NULL" : `'${value.replace(/'/gu, "''")}'`;
}

/** One value in a Markdown cell: a pipe would end the cell, and a line break would end the row. */
function markdownCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}
