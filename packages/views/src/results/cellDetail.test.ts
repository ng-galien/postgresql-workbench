import { describe, expect, it } from "vitest";
import { onMac } from "../platform.js";
import { cellDetail, followsCellLink, postgresArrayItems } from "./cellDetail.js";

describe("what a cell holds, once it is worth more than one line", () => {
  it("lays a document out", () => {
    const detail = cellDetail({ kind: "json", value: '{"b":1,"a":{"c":[1,2]}}' });

    expect(detail).toEqual({
      shape: "json",
      text: '{\n  "b": 1,\n  "a": {\n    "c": [\n      1,\n      2\n    ]\n  }\n}',
    });
  });

  it("shows an unparseable document as plain text without a parser error", () => {
    const detail = cellDetail({ kind: "json", value: "{oops" });

    expect(detail).toEqual({ shape: "text", text: "{oops" });
  });

  it("does not parse a non-JSON PostgreSQL type even if an old payload labelled it JSON", () => {
    expect(
      cellDetail({ kind: "json", value: "2026-08-21T14:00:08.399Z" }, "timestamp with time zone"),
    ).toEqual({ shape: "text", text: "2026-08-21T14:00:08.399Z" });
  });

  it("takes a list apart", () => {
    expect(cellDetail({ kind: "text", value: '{fumé,poisson,"sans gluten"}' }, "text[]")).toEqual({
      shape: "list",
      items: ["fumé", "poisson", "sans gluten"],
    });
  });

  it("says how many bytes there are, what they look like, and carries the picture", () => {
    const hex = "89504e470d0a1a0a0000000d49484452";
    const detail = cellDetail({ kind: "binary", value: `\\x${hex}` });

    expect(detail).toEqual({
      shape: "binary",
      bytes: 16,
      looksLike: "PNG image",
      head: "89 50 4e 47 0d 0a 1a 0a 00 00 00 0d 49 48 44 52",
      truncated: false,
      image: { mediaType: "image/png", hex },
    });
  });

  it("describes a picture that was cut short rather than carrying half of one", () => {
    const detail = cellDetail({
      kind: "binary",
      value: "\\x89504e470d0a1a0a…",
      truncated: true,
    });

    expect(detail).toMatchObject({ shape: "binary", looksLike: "PNG image", truncated: true });
    expect((detail as { image?: unknown }).image).toBeUndefined();
  });

  it("offers an address as somewhere to go", () => {
    expect(cellDetail({ kind: "text", value: "https://example.test/a.pdf" })).toEqual({
      shape: "link",
      href: "https://example.test/a.pdf",
    });
    // A sentence that merely mentions one is a sentence.
    expect(cellDetail({ kind: "text", value: "see https://example.test" })).toMatchObject({
      shape: "text",
    });
  });

  it("says when there is no value at all", () => {
    expect(cellDetail({ kind: "null", value: null })).toEqual({ shape: "empty" });
  });

  it("leaves anything else whole", () => {
    expect(cellDetail({ kind: "text", value: "Saumon fumé" })).toEqual({
      shape: "text",
      text: "Saumon fumé",
    });
  });
});

describe("taking a PostgreSQL array literal apart", () => {
  it("keeps what a quoted item holds", () => {
    expect(postgresArrayItems('{a,"b,c","d{e}",f}')).toEqual(["a", "b,c", "d{e}", "f"]);
  });

  it("reads an escaped quote inside an item", () => {
    expect(postgresArrayItems('{"say \\"hi\\""}')).toEqual(['say "hi"']);
  });

  it("gives an empty list for an empty array", () => {
    expect(postgresArrayItems("{}")).toEqual([]);
  });

  it("is not fooled by a value that merely looks like one", () => {
    // A jsonb object starts with a brace too, and its type says it is not an array.
    expect(postgresArrayItems('{"a": 1}', "jsonb")).toBeUndefined();
    expect(postgresArrayItems("plain text")).toBeUndefined();
  });
});

describe("followsCellLink", () => {
  const chord = (modifier: "metaKey" | "ctrlKey") => ({
    metaKey: modifier === "metaKey",
    ctrlKey: modifier === "ctrlKey",
  });

  it("takes the chord this platform names, and only that one", () => {
    const mac = onMac();
    expect(followsCellLink(chord(mac ? "metaKey" : "ctrlKey"))).toBe(true);
    expect(followsCellLink(chord(mac ? "ctrlKey" : "metaKey"))).toBe(false);
  });

  it("leaves a plain click to the grid", () => {
    expect(followsCellLink({ metaKey: false, ctrlKey: false })).toBe(false);
  });
});
