import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PostgresSourceView } from "./PostgresSourceView.js";

describe("PostgreSQL readonly source view", () => {
  it("renders one explicit row and one gutter cell per source line", () => {
    const html = renderToStaticMarkup(
      <PostgresSourceView
        source={{
          lines: [
            {
              number: 7,
              tokens: [
                { text: "SELECT", offset: 0, className: "postgres-token-keyword" },
                { text: " 1;", offset: 6 },
              ],
            },
            { number: 8, tokens: [] },
            { number: 12, tokens: [{ text: "  <unsafe>", offset: 0 }] },
          ],
        }}
      />,
    );

    expect(html.match(/class="postgres-source-line"/g)).toHaveLength(3);
    expect(html.match(/class="postgres-source-line-number"/g)).toHaveLength(3);
    expect(html).toContain('data-source-line="7"');
    expect(html).toContain('data-source-line="8"');
    expect(html).toContain('data-source-line="12"');
    expect(html).toContain("postgres-token-keyword");
    expect(html).toContain("  &lt;unsafe&gt;");
    expect(html).not.toContain("<pre");
    expect(html).not.toContain('class="shiki');
  });
});
