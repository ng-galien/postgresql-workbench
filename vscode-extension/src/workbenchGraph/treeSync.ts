import type * as vscode from "vscode";
import type {
  PlpgsqlTreeItem,
  WorkbenchGraphView,
  WorkbenchIndexController,
  WorkbenchObjectModel,
  WorkbenchTreeProvider,
} from "../workbench/index.js";

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

  invalidateCockpitContext(): void {
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
    const state = this.index.databaseState(object);
    const result = state.result;
    if (state.status !== "available" || !item || !result) return false;
    await this.revealProgrammatically(item, { select: true, focus: true, expand: true });
    if (!this.graph.currentScope) return true;
    return this.graph.syncObjectFromTree(item.object, result);
  }

  async select(item: PlpgsqlTreeItem): Promise<boolean> {
    this.selected = item;
    if (!this.graph.isOpen || !this.graph.currentScope) return false;
    if (item.kind === "databaseSource" || item.kind === "sourcesSnapshot") {
      const identity = { serverId: item.server.id, database: item.server.database };
      const state = this.index.databaseState(identity);
      const result = state.result;
      if (state.status !== "available" || !result) return false;
      return this.graph.openDatabase(identity, result);
    }
    if (item.kind === "schema") {
      const identity = { serverId: item.server.id, database: item.server.database };
      const state = this.index.databaseState(identity);
      const result = state.result;
      if (state.status !== "available" || !result) return false;
      if (
        this.graph.currentDatabase?.serverId !== identity.serverId ||
        this.graph.currentDatabase.database !== identity.database
      ) {
        return this.graph.openSchema(identity, item.schema, result);
      }
      return this.graph.syncSchemaFromTree(item.schema, result);
    }
    if (item.kind === "function" || item.kind === "object") {
      const state = this.index.databaseState(item.object);
      const result = state.result;
      if (state.status !== "available" || !result) return false;
      return this.graph.syncObjectFromTree(item.object, result);
    }
    if (item.kind === "tableMember" || item.kind === "relationGroup") {
      const state = this.index.databaseState(item.object);
      const result = state.result;
      if (state.status !== "available" || !result) return false;
      return this.graph.syncObjectFromTree(item.object, result);
    }
    if (item.kind === "extensionGroup") {
      const owner = item.objects[0];
      if (!owner) return false;
      const identity = { serverId: owner.serverId, database: owner.database };
      const state = this.index.databaseState(identity);
      const result = state.result;
      if (state.status !== "available" || !result) return false;
      if (
        this.graph.currentDatabase?.serverId !== identity.serverId ||
        this.graph.currentDatabase.database !== identity.database
      ) {
        return this.graph.openSchema(identity, item.schema, result);
      }
      return this.graph.syncSchemaFromTree(item.schema, result);
    }
    if (item.kind === "relationTarget" && item.target.object) {
      const state = this.index.databaseState(item.target.object);
      const result = state.result;
      if (state.status !== "available" || !result) return false;
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
