import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SqlErrorView } from "./SqlErrorView.js";

describe("SqlErrorView", () => {
  it("renders structured PostgreSQL diagnostics without an internal stack trace", () => {
    const html = renderToStaticMarkup(
      <SqlErrorView
        payload={{
          version: 1,
          type: "error",
          category: "postgresql",
          title: "PostgreSQL error",
          message: 'relation "missing_table" does not exist',
          statement: 2,
          code: "42P01",
          detail: "The table was not found.",
          hint: "Check the schema name.",
          position: "15",
        }}
      />,
    );

    expect(html).toContain('aria-label="PostgreSQL query error"');
    expect(html).toContain("Statement 2");
    expect(html).toContain("42P01");
    expect(html).toContain("The table was not found.");
    expect(html).toContain("Check the schema name.");
    expect(html).not.toContain("sqlNotebook.ts");
    expect(html).not.toMatch(/\n\s*at\s/u);
  });

  it("offers SQL analysis settings only for a recoverable budget error", () => {
    const html = renderToStaticMarkup(
      <SqlErrorView
        messaging={{ postMessage() {}, subscribe: () => () => {} }}
        payload={{
          version: 1,
          type: "error",
          category: "execution",
          title: "SQL analysis budget reached",
          message: "Increase the SQL analysis budget and run the cell again.",
          action: {
            type: "open-sql-analysis-settings",
            label: "Open SQL analysis settings",
          },
        }}
      />,
    );

    expect(html).toContain("Open SQL analysis settings");
    expect(html).toContain("result-button-primary");
  });

  it("offers a Scratchpad timeout action for a PostgreSQL Statement timeout", () => {
    const html = renderToStaticMarkup(
      <SqlErrorView
        messaging={{ postMessage() {}, subscribe: () => () => {} }}
        payload={{
          version: 1,
          type: "error",
          category: "postgresql",
          title: "PostgreSQL error",
          message: "canceling statement due to statement timeout",
          code: "57014",
          action: {
            type: "increase-scratchpad-timeout",
            label: "Increase Scratchpad timeout…",
          },
        }}
      />,
    );

    expect(html).toContain("Increase Scratchpad timeout…");
    expect(html).toContain("result-button-primary");
  });
});
