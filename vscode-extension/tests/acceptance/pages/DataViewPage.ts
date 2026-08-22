import { expect, type Frame, type Locator } from "@playwright/test";
import { currentPage, type PageProvider } from "./PageProvider";

/**
 * The Data View as VS Code shows it. What this lane proves is the one thing the shell lane cannot:
 * that the view reaches the webview at all and that the host on the other side of the wire answers
 * it. Everything the grid then does — selecting, editing, exporting — is proven against a real
 * PostgreSQL in packages/shell/tests, where a journey costs a second rather than a minute.
 */
export class DataViewPage {
  private frame?: Frame;

  constructor(private readonly pageProvider: PageProvider) {}

  private get page() {
    return currentPage(this.pageProvider);
  }

  /** Waits for the webview to be there and to have drawn something of the query. */
  async waitUntilOpen(): Promise<void> {
    this.frame = await this.findFrame();
    await expect(this.toolbar).toBeVisible({ timeout: 15_000 });
  }

  private located(selector: string): Locator {
    if (!this.frame) throw new Error("DataViewPage.waitUntilOpen() must be called first");
    return this.frame.locator(selector);
  }

  get toolbar(): Locator {
    return this.located(".data-view-toolbar");
  }

  /** The line above the rows: how many there are, how to walk them, whether they may be written. */
  get rowsLine(): Locator {
    return this.located(".data-view-rows-line");
  }

  get rowCount(): Locator {
    return this.located(".result-navigation-summary");
  }

  get headers(): Locator {
    return this.located("thead th:not(.row-gutter)");
  }

  get rows(): Locator {
    return this.located("tbody tr:not(.result-spacer)");
  }

  get gutter(): Locator {
    return this.located("tbody th.row-gutter");
  }

  /** One per table the query draws from: what it is, and where it is taken out of the query. */
  get tableBadges(): Locator {
    return this.located(".data-view-table-badge");
  }

  /** Where the rows come from, said in prose — only there when no badge says it. */
  get sourceTitle(): Locator {
    return this.located(".data-view-title");
  }

  get statusLine(): Locator {
    return this.located(".data-view-statusline-text");
  }

  /** What went wrong, if anything did: the band across the top of the view. */
  get failure(): Locator {
    return this.located(".data-view-alert");
  }

  cellsWithText(text: string): Locator {
    return this.located("tbody td").filter({ hasText: text });
  }

  private async findFrame(): Promise<Frame> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      for (const frame of this.page.frames()) {
        if (frame === this.page.mainFrame()) continue;
        if ((await frame.locator(".data-view").count()) > 0) return frame;
      }
      await this.page.waitForTimeout(100);
    }
    throw new Error("The Data View webview frame did not become available.");
  }
}
