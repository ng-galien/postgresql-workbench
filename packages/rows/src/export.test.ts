import { describe, expect, it } from "vitest";
import {
  CLIPBOARD_EXPORT,
  type DataViewExportChoice,
  DEFAULT_DATA_VIEW_EXPORT,
  dataViewExportText,
  dataViewExportWriter,
  type ExportColumn,
  exportDelimiterFor,
  exportFileExtension,
  exportStreams,
  parseDelimitedText,
} from "./export.js";

const COLUMNS: ExportColumn[] = [
  { name: "label", type: "text" },
  { name: "line2", type: "character varying(80)" },
  { name: "city", type: "text" },
];

/** Columns named but untyped, which is all a shape other than SQL ever reads. */
function named(...names: string[]): ExportColumn[] {
  return names.map((name) => ({ name }));
}
const ROWS: (string | null)[][] = [
  ["Bob", null, "Bordeaux"],
  ["Épices & Terroirs", "bâtiment B", "Lyon"],
];

function choose(over: Partial<DataViewExportChoice>): DataViewExportChoice {
  return { ...DEFAULT_DATA_VIEW_EXPORT, ...over };
}

describe("writing a result out", () => {
  it("writes a comma-separated file with a header", () => {
    expect(dataViewExportText(COLUMNS, ROWS, choose({}))).toBe(
      "label,line2,city\nBob,,Bordeaux\nÉpices & Terroirs,bâtiment B,Lyon\n",
    );
  });

  it("leaves out the header when the reader does not want one", () => {
    expect(dataViewExportText(COLUMNS, ROWS, choose({ header: false })).split("\n")[0]).toBe(
      "Bob,,Bordeaux",
    );
  });

  it("says a NULL the way the reader asked for it", () => {
    const line = (nullAs: DataViewExportChoice["nullAs"]) =>
      dataViewExportText(COLUMNS, [ROWS[0] ?? []], choose({ header: false, nullAs })).trim();

    expect(line("empty")).toBe("Bob,,Bordeaux");
    expect(line("null")).toBe("Bob,NULL,Bordeaux");
    expect(line("backslash-n")).toBe("Bob,\\N,Bordeaux");
  });

  it("quotes a value the delimiter, a quote or a line break would otherwise break apart", () => {
    const rows = [["a,b", 'say "hi"', "one\ntwo"]];
    expect(dataViewExportText(COLUMNS, rows, choose({ header: false })).trim()).toBe(
      '"a,b","say ""hi""","one\ntwo"',
    );
  });

  it("keeps a spreadsheet from reading a value as a formula", () => {
    const rows = [["=1+1", "-3", "@here"]];
    expect(dataViewExportText(COLUMNS, rows, choose({ header: false })).trim()).toBe(
      "'=1+1,'-3,'@here",
    );
    // Not on the clipboard, though: this grid reads that back, and the prefix would stay in.
    expect(dataViewExportText(COLUMNS, rows, CLIPBOARD_EXPORT).trim()).toBe("=1+1\t-3\t@here");
  });

  it("writes tabs for a TSV whatever delimiter was last chosen", () => {
    expect(dataViewExportText(COLUMNS, [ROWS[0] ?? []], choose({ format: "tsv" })).trim()).toBe(
      "label\tline2\tcity\nBob\t\tBordeaux",
    );
    expect(exportDelimiterFor("tsv", ";")).toBe("\t");
    // A CSV keeps a chosen semicolon, which is what a French spreadsheet reads.
    expect(exportDelimiterFor("csv", ";")).toBe(";");
    // But it never keeps a tab, which is the other shape's whole point.
    expect(exportDelimiterFor("csv", "\t")).toBe(",");
  });

  it("writes JSON as one record per row, with NULL kept as null", () => {
    const text = dataViewExportText(COLUMNS, ROWS, choose({ format: "json" }));
    expect(JSON.parse(text)).toEqual([
      { label: "Bob", line2: null, city: "Bordeaux" },
      { label: "Épices & Terroirs", line2: "bâtiment B", city: "Lyon" },
    ]);
  });

  it("writes INSERT statements against the table the rows came from", () => {
    const text = dataViewExportText(
      COLUMNS,
      ROWS,
      choose({ format: "sql", table: "shop.address" }),
    );

    expect(text).toBe(
      "INSERT INTO shop.address (label, line2, city)\nVALUES ('Bob', NULL, 'Bordeaux');\n" +
        "INSERT INTO shop.address (label, line2, city)\n" +
        "VALUES ('Épices & Terroirs', 'bâtiment B', 'Lyon');\n",
    );
  });

  it("doubles a quote inside a SQL literal, so a value cannot become syntax", () => {
    const text = dataViewExportText(
      named("label"),
      [["l'Essai"]],
      choose({ format: "sql", table: "shop.address" }),
    );
    expect(text).toContain("VALUES ('l''Essai');");
  });

  it("puts a table the rows can go into before them, when asked", () => {
    const text = dataViewExportText(
      COLUMNS,
      [ROWS[0] ?? []],
      choose({ format: "sql", table: "shop.address", createTable: true }),
    );

    // The schema too: a script that assumes one fails on the database it is most useful on.
    expect(text).toBe(`CREATE SCHEMA IF NOT EXISTS shop;
CREATE TABLE IF NOT EXISTS shop.address (
  label text,
  line2 character varying(80),
  city text
);

INSERT INTO shop.address (label, line2, city)
VALUES ('Bob', NULL, 'Bordeaux');
`);
  });

  it("leaves the table out unless it was asked for", () => {
    const text = dataViewExportText(
      COLUMNS,
      [ROWS[0] ?? []],
      choose({ format: "sql", table: "shop.address" }),
    );

    expect(text.startsWith("INSERT INTO")).toBe(true);
  });

  it("writes a column with no type known as text, rather than not at all", () => {
    const text = dataViewExportText(
      named("mystery"),
      [["x"]],
      choose({ format: "sql", table: "public.t", createTable: true }),
    );

    expect(text).toContain("mystery text");
  });

  it("refuses to write INSERT statements with no table to write them against", () => {
    expect(() => dataViewExportText(COLUMNS, ROWS, choose({ format: "sql" }))).toThrow(
      /need a table/u,
    );
  });

  it("lines a Markdown table's columns up", () => {
    expect(
      dataViewExportText(
        named("id", "label"),
        [
          ["1", "Bob"],
          ["10", null],
        ],
        choose({ format: "markdown" }),
      ),
    ).toBe(`| id  | label |
|-----|-------|
| 1   | Bob   |
| 10  |       |
`);
  });

  it("keeps a pipe from ending a Markdown cell", () => {
    expect(dataViewExportText(named("a"), [["x|y"]], choose({ format: "markdown" }))).toContain(
      "x\\|y",
    );
  });
});

describe("writing a result out a piece at a time", () => {
  it("gives the same text as writing it whole", () => {
    const choice = choose({ format: "json" });
    const writer = dataViewExportWriter(COLUMNS, choice);
    const streamed = [
      writer.opening(),
      ...ROWS.map((row, index) => writer.row(row, index)),
      writer.closing(),
    ].join("");

    expect(streamed).toBe(dataViewExportText(COLUMNS, ROWS, choice));
  });

  it("says which shapes can be written in pieces at all", () => {
    expect(exportStreams("csv")).toBe(true);
    expect(exportStreams("json")).toBe(true);
    expect(exportStreams("sql")).toBe(true);
    // A Markdown table cannot: its columns are lined up, which needs every row measured first.
    expect(exportStreams("markdown")).toBe(false);
    expect(() => dataViewExportWriter(COLUMNS, choose({ format: "markdown" }))).toThrow(
      /written whole/u,
    );
  });

  it("reads back what it wrote, quotes and line breaks and all", () => {
    const rows = [
      ["a,b", 'say "hi"', "one\ntwo"],
      ["Bob", "", "Bordeaux"],
    ];
    const written = dataViewExportText(COLUMNS, rows, choose({ header: false }));

    expect(parseDelimitedText(written, ",")).toEqual(rows);
  });

  it("reads a clipboard line back exactly as this grid wrote it", () => {
    const rows = [["=1+1", "with\ttab", "plain"]];
    const written = dataViewExportText(COLUMNS, rows, CLIPBOARD_EXPORT);

    expect(parseDelimitedText(written, "\t")).toEqual(rows);
  });

  it("reads plain text a spreadsheet put there, with no quoting at all", () => {
    expect(parseDelimitedText("Brest\nBayonne\nColmar", "\t")).toEqual([
      ["Brest"],
      ["Bayonne"],
      ["Colmar"],
    ]);
    expect(parseDelimitedText("a\tb\r\nc\td", "\t")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("ends a file with a newline, and the clipboard without one", () => {
    expect(dataViewExportText(COLUMNS, ROWS, choose({}))).toMatch(/\n$/u);
    // A trailing newline on the clipboard is one empty row in whatever the reader pastes into.
    expect(dataViewExportText(COLUMNS, ROWS, CLIPBOARD_EXPORT)).not.toMatch(/\n$/u);
    expect(dataViewExportText(COLUMNS, ROWS, CLIPBOARD_EXPORT).split("\n")).toHaveLength(2);
  });

  it("names the file after the shape", () => {
    expect(exportFileExtension("csv")).toBe("csv");
    expect(exportFileExtension("markdown")).toBe("md");
  });
});
