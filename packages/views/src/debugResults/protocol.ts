import type { DebugResultViewState } from "../../../rows/src/resultPayload.js";

/** What the debug results view and the Extension Host send each other. */
export type DebugResultsRequest =
  | { type: "ready" }
  | { type: "select"; id: string }
  | { type: "copy" }
  | { type: "openSource" };

export type DebugResultsResponse =
  | { type: "state"; state: DebugResultViewState }
  | { type: "copyResult"; ok: boolean };
