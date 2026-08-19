import type { WorkbenchObjectModel } from "../../../packages/catalog/src/objectModel.js";

export type WorkbenchObjectActionId =
  | "open-definition"
  | "open-data"
  | "open-deployed-source"
  | "open-graph"
  | "debug"
  | "show-tests"
  | "run-tests"
  | "run-with-coverage";

export interface WorkbenchObjectAction {
  id: WorkbenchObjectActionId;
  label: string;
  description: string;
  icon: string;
}

export interface WorkbenchObjectActionCapabilities {
  hasMappedTests?: boolean;
}

export type WorkbenchObjectActionSurface = "default" | "cockpit";

const ACTIONS: Record<WorkbenchObjectActionId, WorkbenchObjectAction> = {
  "open-definition": {
    id: "open-definition",
    label: "Open Indexed Definition",
    description: "Open the definition from the current Code Moniker snapshot",
    icon: "go-to-file",
  },
  "open-data": {
    id: "open-data",
    label: "Open Data View",
    description: "Browse the rows in a bounded, sortable, filterable Data View",
    icon: "table",
  },
  "open-deployed-source": {
    id: "open-deployed-source",
    label: "Open Deployed PL/pgSQL Source",
    description: "Open the live routine source used by the debugger",
    icon: "file-code",
  },
  "open-graph": {
    id: "open-graph",
    label: "Open Focused Graph",
    description: "Explore direct indexed relations around this object",
    icon: "type-hierarchy",
  },
  debug: {
    id: "debug",
    label: "Debug Routine",
    description: "Launch the existing PL/pgSQL debug workflow",
    icon: "debug-alt",
  },
  "show-tests": {
    id: "show-tests",
    label: "Show Mapped pgTAP Tests",
    description: "Reveal tests associated with this routine",
    icon: "beaker",
  },
  "run-tests": {
    id: "run-tests",
    label: "Run Mapped pgTAP Tests",
    description: "Run associated tests with the native Test Controller",
    icon: "run-all",
  },
  "run-with-coverage": {
    id: "run-with-coverage",
    label: "Run Mapped Tests with Coverage",
    description: "Use the existing transactional PL/pgSQL coverage profile",
    icon: "coverage",
  },
};

export function buildWorkbenchObjectActions(
  object: WorkbenchObjectModel,
  capabilities: WorkbenchObjectActionCapabilities = {},
): WorkbenchObjectAction[] {
  const actions: WorkbenchObjectActionId[] = ["open-definition"];
  if (object.kind === "table" || object.kind === "view") actions.push("open-data");
  const isPlpgsqlRoutine =
    object.plpgsql && (object.kind === "function" || object.kind === "procedure");
  if (isPlpgsqlRoutine) {
    actions.push("open-deployed-source");
  }
  actions.push("open-graph");
  if (isPlpgsqlRoutine) {
    actions.push("debug");
    if (capabilities.hasMappedTests) {
      actions.push("show-tests", "run-tests", "run-with-coverage");
    }
  }
  return actions.map((action) => ACTIONS[action]);
}

export function actionsForWorkbenchSurface(
  actions: readonly WorkbenchObjectAction[],
  surface: WorkbenchObjectActionSurface,
): WorkbenchObjectAction[] {
  if (surface !== "cockpit") return [...actions];
  return actions.filter(({ id }) => id !== "open-definition" && id !== "open-graph");
}
