import type * as vscode from "vscode";
import type { WorkbenchGraphView } from "../workbenchGraphView.js";
import type { WorkbenchIndexController } from "../workbenchIndexController.js";
import type { WorkbenchObjectModel } from "../workbenchTreeModel.js";
import type { PlpgsqlTreeItem, WorkbenchTreeProvider } from "../workbenchTreeProvider.js";

export class WorkbenchGraphTreeSync {
  private revealing = false;
  private selected?: PlpgsqlTreeItem;

  constructor(
    private readonly tree: vscode.TreeView<PlpgsqlTreeItem>,
    private readonly provider: WorkbenchTreeProvider,
    private readonly index: WorkbenchIndexController,
    private readonly graph: WorkbenchGraphView,
  ) {}

  bind(): vscode.Disposable {
    return this.tree.onDidChangeSelection(({ selection }) => {
      if (selection.length === 1) void this.select(selection[0]);
    });
  }

  get currentSelection(): PlpgsqlTreeItem | undefined {
    return this.selected;
  }

  invalidateDatabaseContext(): void {
    this.selected = undefined;
  }

  async revealObject(object: WorkbenchObjectModel): Promise<boolean> {
    const item = this.provider.itemForObject(object);
    if (!item) return false;
    this.revealing = true;
    try {
      await this.tree.reveal(item, { select: true, focus: false, expand: true });
      return true;
    } finally {
      setTimeout(() => {
        this.revealing = false;
      }, 0);
    }
  }

  async navigateToObject(object: WorkbenchObjectModel): Promise<boolean> {
    const item = this.provider.itemForObject(object);
    const result = this.index.state.result;
    if (this.index.state.status !== "available" || !item || !result) return false;
    this.revealing = true;
    try {
      await this.tree.reveal(item, { select: true, focus: true, expand: true });
      if (!this.graph.currentScope) return true;
      return this.graph.syncObjectFromTree(item.object, result);
    } finally {
      setTimeout(() => {
        this.revealing = false;
      }, 0);
    }
  }

  async select(item: PlpgsqlTreeItem): Promise<boolean> {
    this.selected = item;
    if (this.revealing || !this.graph.currentScope) return false;
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
}
