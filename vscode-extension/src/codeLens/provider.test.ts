import { describe, expect, it, vi } from "vitest";
import { shouldProvideSqlCodeLenses } from "./provider.js";

vi.mock("vscode", () => ({}));

describe("SQL CodeLens surfaces", () => {
  it("leaves Scratchpad connection ownership to the NotebookBinding", () => {
    expect(shouldProvideSqlCodeLenses("vscode-notebook-cell")).toBe(false);
  });

  it("leaves the Data View query document to its own lens", () => {
    expect(shouldProvideSqlCodeLenses("postgresql-workbench-data-sql")).toBe(false);
  });

  it.each(["file", "untitled", "code+moniker"])("keeps CodeLens in %s editors", (scheme) => {
    expect(shouldProvideSqlCodeLenses(scheme)).toBe(true);
  });
});
