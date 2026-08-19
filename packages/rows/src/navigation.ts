import type { SqlResultSession } from "./cursor.js";
import type { SqlNotebookResultNavigation, SqlNotebookResultPayload } from "./resultPayload.js";

/**
 * What a reader can ask of a bounded result, whatever surface asks it. One vocabulary for the
 * Scratchpad output, the Data View, and anything that reads rows through a cursor.
 */
export type ResultNavigationAction = "attach" | "previous" | "next" | "load-all" | "cancel";

/** The ones a reader triggers: `attach` is the host's own first read, never a control. */
export type ResultNavigationCommand = Exclude<ResultNavigationAction, "attach">;

/** What a surface knows about its own result when it decides what to offer. */
export interface ResultNavigationState {
  navigation?: SqlNotebookResultNavigation;
  /** An action is already running. */
  busy: boolean;
  /** The cursor is gone: only a fresh load can bring rows back. */
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
  if (action === "cancel") return state.busy;
  if (state.busy || state.closed || !state.navigation) return false;
  if (action === "previous") return state.navigation.hasPrevious;
  if (action === "next") return state.navigation.hasNext;
  return state.navigation.canLoadAll;
}

/**
 * What each action means against a session. Closing is left to the caller: a surface owns how it
 * announces a cursor it will not reopen.
 */
export async function navigateResult(
  session: SqlResultSession,
  action: Exclude<ResultNavigationAction, "cancel">,
  onProgress?: (loadedRowCount: number) => void,
): Promise<SqlNotebookResultPayload> {
  if (action === "previous") return session.previous();
  if (action === "next") return session.next();
  if (action === "load-all") return session.loadAll(onProgress);
  return session.snapshot();
}
