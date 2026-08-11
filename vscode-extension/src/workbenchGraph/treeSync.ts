import type * as vscode from "vscode";
import type { WorkbenchGraphView } from "../workbenchGraphView.js";
import type { WorkbenchIndexController } from "../workbenchIndexController.js";
import type { WorkbenchObjectModel } from "../workbenchTreeModel.js";
import type { PlpgsqlTreeItem, WorkbenchTreeProvider } from "../workbenchTreeProvider.js";

export class WorkbenchGraphTreeSync {
  private readonly pendingReveals = new Set<Promise<boolean>>();
  private readonly programmaticSelectionIds = new Set<string>();
  private selected?: PlpgsqlTreeItem;

  constructor(
    private readonly tree: vscode.TreeView<PlpgsqlTreeItem>,
    private readonly provider: WorkbenchTreeProvider,
    private readonly index: WorkbenchIndexController,
    private readonly graph: WorkbenchGraphView,
  ) {}

  bind(): vscode.Disposable {
    return this.tree.onDidChangeSelection(({ selection }) => {
      if (selection.length !== 1) return;
      const [item] = selection;
      const programmatic = item.id !== undefined && this.programmaticSelectionIds.delete(item.id);
      if (programmatic) {
        this.selected = item;
        return;
      }
      this.programmaticSelectionIds.clear();
      void this.select(item);
    });
  }

  get currentSelection(): PlpgsqlTreeItem | undefined {
    return this.selected;
  }

  invalidateDatabaseContext(): void {
    this.selected = undefined;
  }

  waitForIdle(): Promise<void> {
    return Promise.allSettled([...this.pendingReveals]).then(() => undefined);
  }

  async resetSelection(item: PlpgsqlTreeItem): Promise<void> {
    await this.waitForIdle();
    await this.revealProgrammatically(item, { select: true, focus: false, expand: false });
    this.selected = undefined;
  }

  revealObject(object: WorkbenchObjectModel): Promise<boolean> {
    return this.trackReveal(this.revealObjectNow(object));
  }

  private async revealObjectNow(object: WorkbenchObjectModel): Promise<boolean> {
    const item = this.provider.itemForObject(object);
    if (!item) return false;
    await this.revealProgrammatically(item, { select: true, focus: false, expand: true });
    return true;
  }

  navigateToObject(object: WorkbenchObjectModel): Promise<boolean> {
    return this.trackReveal(this.navigateToObjectNow(object));
  }

  private async navigateToObjectNow(object: WorkbenchObjectModel): Promise<boolean> {
    const item = this.provider.itemForObject(object);
    const result = this.index.state.result;
    if (this.index.state.status !== "available" || !item || !result) return false;
    await this.revealProgrammatically(item, { select: true, focus: true, expand: true });
    if (!this.graph.currentScope) return true;
    return this.graph.syncObjectFromTree(item.object, result);
  }

  async select(item: PlpgsqlTreeItem): Promise<boolean> {
    this.selected = item;
    if (!this.graph.isOpen || !this.graph.currentScope) return false;
    const result = this.index.state.result;
    if (this.index.state.status !== "available" || !result) return false;
    if (item.kind === "databaseSource" || item.kind === "sourcesSnapshot") {
      if (
        !item.active ||
        item.server.id !== result.serverId ||
        item.server.database !== result.database
      ) {
        return false;
      }
      return this.graph.openDatabase(
        { serverId: result.serverId, database: result.database },
        result,
      );
    }
    if (item.kind === "schema") {
      return this.graph.syncSchemaFromTree(item.schema, result);
    }
    if (item.kind === "function" || item.kind === "object") {
      return this.graph.syncObjectFromTree(item.object, result);
    }
    if (item.kind === "tableMember" || item.kind === "relationGroup") {
      return this.graph.syncObjectFromTree(item.object, result);
    }
    if (item.kind === "extensionGroup") {
      return this.graph.syncSchemaFromTree(item.schema, result);
    }
    if (item.kind === "relationTarget" && item.target.object) {
      return this.graph.syncObjectFromTree(item.target.object, result);
    }
    return false;
  }

  private async trackReveal(run: Promise<boolean>): Promise<boolean> {
    this.pendingReveals.add(run);
    try {
      return await run;
    } finally {
      this.pendingReveals.delete(run);
    }
  }

  private async revealProgrammatically(
    item: PlpgsqlTreeItem,
    options: { select: boolean; focus: boolean; expand: boolean },
  ): Promise<void> {
    if (item.id !== undefined) this.programmaticSelectionIds.add(item.id);
    try {
      await this.tree.reveal(item, options);
    } finally {
      if (item.id !== undefined) this.programmaticSelectionIds.delete(item.id);
    }
  }
}
