import { demoAssociationText } from "../../fixtures/demoDatabase";
import { expect, test } from "../../fixtures/test";
import { createScratchpad } from "../../journeys/scratchpad";

/**
 * The command palette offers a Scratchpad command with nothing selected and no Scratchpad open.
 * These four used to return in silence, which reads exactly like a command that is broken: the
 * reader asks for it, nothing happens, and nothing says why. They now answer the way Open, Rename,
 * Delete, Duplicate and Export have always answered — by offering the workspace's Scratchpads to
 * choose from, each pick named for the command that opened it.
 */
const SCRATCHPAD_COMMANDS = [
  [
    "PostgreSQL Workbench: Scratchpads: Association...",
    "Change the Association of a SQL scratchpad",
  ],
  ["PostgreSQL Workbench: Scratchpads: Reconnect", "Reconnect a SQL scratchpad"],
  ["PostgreSQL Workbench: Scratchpads: Connect", "Connect the Association of a SQL scratchpad"],
  [
    "PostgreSQL Workbench: Scratchpads: Statement Timeout...",
    "Set the Statement timeout of a SQL scratchpad",
  ],
] as const;

test.describe("Scratchpad commands asked for from the palette", () => {
  test("offer the workspace's Scratchpads when none is open", async ({
    vscode,
    workbench,
    notebook,
  }) => {
    const scratchpad = await createScratchpad(workbench, notebook, demoAssociationText);
    // A tree row runs its name into its Association with no separator, so read the name itself.
    const name = /Scratch \d+/u.exec((await scratchpad.textContent()) ?? "")?.[0];
    expect(name).toBeDefined();

    // The reader is no longer looking at it: this is the state every one of these commands used
    // to answer with nothing at all.
    await workbench.reset();

    for (const [title, placeHolder] of SCRATCHPAD_COMMANDS) {
      await vscode.page.keyboard.press("F1");
      await workbench.quickInput.fill(`>${title}`);
      // The palette must offer this exact command, not a neighbour it fuzzy-matched.
      await expect(vscode.page.locator(".quick-input-list .monaco-list-row").first()).toContainText(
        title,
      );
      await vscode.page.keyboard.press("Enter");

      // The command asks which Scratchpad, naming itself, and offers the one that exists.
      await expect(workbench.quickInput.input).toHaveAttribute("aria-label", placeHolder, {
        timeout: 5_000,
      });
      await expect(
        vscode.page
          .locator(".quick-input-list:visible .monaco-list-row")
          .filter({ hasText: name ?? "" }),
      ).toHaveCount(1);
      await workbench.quickInput.cancel();
    }
  });
});
