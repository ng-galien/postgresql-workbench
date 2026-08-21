import { describe, expect, it } from "vitest";
import { cellDetail, postgresArrayItems } from "./cellDetail.js";

describe("what a cell holds, once it is worth more than one line", () => {
  it("lays a document out", () => {
    const detail = cellDetail({ kind: "json", value: '{"b":1,"a":{"c":[1,2]}}' });

    expect(detail).toEqual({
      shape: "json",
      text: '{\n  "b": 1,\n  "a": {\n    "c": [\n      1,\n      2\n    ]\n  }\n}',
    });
  });

  it("says why a document would not parse, and shows it as it stands", () => {
    const detail = cellDetail({ kind: "json", value: "{oops" });

    expect(detail).toMatchObject({ shape: "json", text: "{oops" });
    expect((detail as { invalid?: string }).invalid).toBeTruthy();
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
