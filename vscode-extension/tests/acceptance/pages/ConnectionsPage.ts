import { expect, type Frame, type Locator } from "@playwright/test";
import type { VSCodeInstance } from "../fixtures/vscode";
import { currentPage, type PageProvider } from "./PageProvider";

/** The Connections page: the one place a Connection is added, edited, tested and removed. */
export class ConnectionsPage {
  constructor(
    private readonly pageProvider: PageProvider,
    private readonly executeCommand: VSCodeInstance["executeCommand"],
  ) {}

  private get page() {
    return currentPage(this.pageProvider);
  }

  async open(): Promise<Frame> {
    await this.executeCommand("postgresql-workbench.manageConnections");
    return this.frame();
  }

  async frame(): Promise<Frame> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      for (const frame of this.page.frames()) {
        try {
          if ((await frame.getByLabel("Saved Connections").count()) > 0) return frame;
        } catch {
          // A frame can detach while the tab is (re)loading; the next pass sees the final set.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("The Connections page frame did not become available within 10000 ms");
  }

  async startAdding(frame: Frame): Promise<void> {
    await frame.getByRole("button", { name: "New Connection", exact: true }).click();
    await expect(frame.getByRole("heading", { name: "New Connection", level: 2 })).toBeVisible({
      timeout: 5_000,
    });
  }

  async fill(
    frame: Frame,
    values: Partial<Record<"Name" | "Host" | "Port" | "Database" | "User" | "Password", string>>,
  ): Promise<void> {
    for (const [label, value] of Object.entries(values)) {
      const field = frame.getByLabel(label, { exact: true });
      await field.fill(value);
    }
  }

  async testConnection(frame: Frame): Promise<Locator> {
    await frame.getByRole("button", { name: "Test Settings", exact: true }).click();
    const report = frame.getByRole("region", { name: "Connection test result" });
    await expect(report).toBeVisible({ timeout: 15_000 });
    return report;
  }

  listedConnection(frame: Frame, text: string | RegExp): Locator {
    return frame.getByRole("button").filter({ hasText: text });
  }

  async openSettings(frame: Frame, text: string | RegExp): Promise<void> {
    const connection = this.listedConnection(frame, text);
    await connection.locator("..").getByRole("button", { name: "Settings", exact: true }).click();
  }
}
