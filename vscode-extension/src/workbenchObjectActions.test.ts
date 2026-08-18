import { describe, expect, it } from "vitest";
import {
  actionsForWorkbenchSurface,
  buildWorkbenchObjectActions,
  type WorkbenchObjectActionId,
} from "./workbenchObjectActions.js";
import type { WorkbenchObjectModel } from "./workbenchTreeModel.js";

function object(
  kind: WorkbenchObjectModel["kind"],
  options: { plpgsql?: boolean } = {},
): WorkbenchObjectModel {
  return {
    serverId: "localhost:5433/testdb:postgres",
    database: "testdb",
    schema: "public",
    kind,
    name: kind === "table" ? "orders" : "refresh_orders",
    oid: kind === "table" ? 20 : 30,
    signature: "",
    params: [],
    plpgsql: options.plpgsql ?? false,
    sourceUri: `postgresql://server/testdb/public/${kind}/30.sql`,
    symbolUri: `code+moniker://./lang:sql/${kind}:public.object`,
  };
}

function actionIds(
  target: WorkbenchObjectModel,
  hasMappedTests = false,
): WorkbenchObjectActionId[] {
  return buildWorkbenchObjectActions(target, { hasMappedTests }).map((action) => action.id);
}

describe("Workbench object actions", () => {
  it("keeps generic database objects limited to definition, data, and graph navigation", () => {
    expect(actionIds(object("table"))).toEqual(["open-definition", "open-data", "open-graph"]);
  });

  it("adds deployed source and debugging only for PL/pgSQL routines", () => {
    expect(actionIds(object("function", { plpgsql: true }))).toEqual([
      "open-definition",
      "open-deployed-source",
      "open-graph",
      "debug",
    ]);
    expect(actionIds(object("function"))).toEqual(["open-definition", "open-graph"]);
  });

  it("adds pgTAP actions only after a mapped test is resolved", () => {
    expect(actionIds(object("procedure", { plpgsql: true }), true)).toEqual([
      "open-definition",
      "open-deployed-source",
      "open-graph",
      "debug",
      "show-tests",
      "run-tests",
      "run-with-coverage",
    ]);
  });

  it("removes actions already represented by the SQL Cockpit", () => {
    const generic = buildWorkbenchObjectActions(object("table"));
    const routine = buildWorkbenchObjectActions(object("function", { plpgsql: true }), {
      hasMappedTests: true,
    });

    expect(actionsForWorkbenchSurface(generic, "cockpit").map(({ id }) => id)).toEqual([
      "open-data",
    ]);
    expect(actionsForWorkbenchSurface(routine, "cockpit").map(({ id }) => id)).toEqual([
      "open-deployed-source",
      "debug",
      "show-tests",
      "run-tests",
      "run-with-coverage",
    ]);
  });
});
