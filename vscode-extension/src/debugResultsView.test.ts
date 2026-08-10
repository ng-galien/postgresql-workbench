import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({}));

import { createDebugResultsHtml } from "./debugResultsView.js";

describe("debug results webview", () => {
  it("renders a nonce-bound, keyboard-operable result grid contract", () => {
    const html = createDebugResultsHtml("test-nonce");

    expect(html).toContain("script-src 'nonce-test-nonce'");
    expect(html).toContain("table.setAttribute('role', 'grid')");
    expect(html).toContain("rowIndex === 0 && columnIndex === 0 ? 0 : -1");
    expect(html).toContain("event.key === 'ArrowRight'");
    expect(html).toContain("event.key === 'Enter' || event.key === ' '");
    expect(html).toContain("event.ctrlKey || event.metaKey");
    expect(html).toContain("Query completed — 0 rows.");
  });

  it("exposes explicit lifecycle, truncation and cell-inspection affordances", () => {
    const html = createDebugResultsHtml("test-nonce");

    expect(html).toContain("Running query");
    expect(html).toContain("Query failed");
    expect(html).toContain("Additional rows are not displayed or exported.");
    expect(html).toContain("Truncated cells have an amber edge.");
    expect(html).toContain("Raw");
    expect(html).toContain("Formatted");
    expect(html).toContain("Open callsite");
  });
});
