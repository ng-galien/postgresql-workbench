import type { FollowLinkRequest } from "../../../rows/src/followLink.js";
import type { DebugResultViewState } from "../../../rows/src/resultPayload.js";
import type {
  SqlResultExportRequest,
  SqlResultInspectedResponse,
  SqlResultInspectRequest,
  SqlResultPreviewedResponse,
  SqlResultPreviewRequest,
} from "../results/payload.js";

/** What the debug results view and the Extension Host send each other. */
export type DebugResultsRequest =
  | { type: "ready" }
  | { type: "select"; id: string }
  | { type: "copy" }
  | { type: "openSource" }
  /* Inspecting, previewing and exporting held rows; the same requests every result surface sends. */
  | SqlResultInspectRequest
  | SqlResultPreviewRequest
  | SqlResultExportRequest
  /* Following an address a cell holds; the same request every result surface sends. */
  | FollowLinkRequest;

export type DebugResultsResponse =
  | { type: "state"; state: DebugResultViewState }
  | { type: "copyResult"; ok: boolean }
  | SqlResultInspectedResponse
  | SqlResultPreviewedResponse;
