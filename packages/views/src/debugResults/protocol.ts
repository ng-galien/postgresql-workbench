import type { DebugResultViewState } from "../../../dap/src/debugger/launch/capturedResults.js";

/** What the debug results view and the Extension Host send each other. */
export type DebugResultsRequest =
  | { type: "ready" }
  | { type: "select"; id: string }
  | { type: "copy"; text: string }
  | { type: "openSource" };

export type DebugResultsResponse =
  | { type: "state"; state: DebugResultViewState }
  | { type: "copyResult"; ok: boolean };
