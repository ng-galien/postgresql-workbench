import type { OffsetResultSession } from "./offsetQuery.js";
import type { SqlNotebookResultNavigation, SqlNotebookResultPayload } from "./resultPayload.js";

/**
 * What a reader can ask of a bounded result, whatever surface asks it. One vocabulary for the
 * Scratchpad output, the Data View, and anything that reads LIMIT/OFFSET pages.
 */
export type ResultNavigationAction = "attach" | "previous" | "next" | "load-all" | "cancel";

/** The ones a reader triggers: `attach` is the host's own first read, never a control. */
export type ResultNavigationCommand = Exclude<ResultNavigationAction, "attach">;

/** What a surface knows about its own result when it decides what to offer. */
export interface ResultNavigationState {
  navigation?: SqlNotebookResultNavigation;
  /** An action is already running. */
  busy: boolean;
  /** The running action owns a page read that this control can cancel. */
  cancellable: boolean;
  /** The paged result cannot execute more queries. */
  closed: boolean;
}

/**
 * Whether the reader may ask for this action right now. The rule lives here so a surface only
 * decides how to show it — a button, an icon, or nothing at all.
 */
export function canNavigate(
  action: ResultNavigationCommand,
  state: ResultNavigationState,
): boolean {
  if (action === "cancel") return state.cancellable;
  if (state.busy || state.closed || !state.navigation) return false;
  if (action === "previous") return state.navigation.hasPrevious;
  if (action === "next") return state.navigation.hasNext;
  return state.navigation.canLoadAll;
}

/** Whether an action must open PostgreSQL rather than only rearranging pages already retained. */
export function navigationReadsPostgres(
  action: ResultNavigationAction,
  payload: SqlNotebookResultPayload | undefined,
): boolean {
  const navigation = payload?.navigation;
  if (!navigation) return false;
  if (action === "next") {
    return navigation.hasNext && navigation.pageEnd >= navigation.loadedRowCount;
  }
  if (action === "load-all") {
    return navigation.canLoadAll && payload.rowCount === undefined;
  }
  return false;
}

/**
 * What each action means against a session. Closing is left to the caller: a surface owns how it
 * announces a result it will not reopen.
 */
export async function navigateResult(
  session: OffsetResultSession,
  action: ResultNavigationAction,
  onProgress?: (loadedRowCount: number) => void,
): Promise<SqlNotebookResultPayload> {
  if (action === "previous") return session.previous();
  if (action === "next") return session.next();
  if (action === "load-all") return session.loadAll(onProgress);
  // `attach` is the host's first read and `cancel` stops the running one: both answer with the
  // rows the session already holds.
  return session.snapshot();
}
