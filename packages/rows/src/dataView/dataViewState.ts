import type { SqlQueryModel } from "../../../sql/src/query/model.js";
import type { SqlNotebookResultPayload } from "../resultPayload.js";
import type {
  DataViewEditability,
  DataViewProjection,
  DataViewQueryInfo,
  DataViewSource,
} from "./dataView.js";
import type { DataViewState, DataViewStatus } from "./dataViewProtocol.js";
import type { HiddenColumns } from "./hiddenColumns.js";
import type { PendingEdits } from "./pendingEdits.js";

/**
 * Everything a host must have in hand to say what its Data View currently is. Two of these come
 * from the host and nothing else does: the name it shows for the server it is connected to, and
 * whether the query has an editor with unsaved text in it.
 */
export interface DataViewStateOf {
  source: DataViewSource;
  serverName: string;
  /** Where the query text lives, so the view can open it. */
  queryUri: string;
  query: SqlQueryModel;
  hidden: HiddenColumns;
  /** Whether the query's own editor holds unsaved text; a surface without one says no. */
  editorDirty: boolean;
  projection: DataViewProjection;
  status: DataViewStatus;
  message?: string;
  payload?: SqlNotebookResultPayload;
  editability: DataViewEditability;
  edits: PendingEdits;
  busy: boolean;
}

/**
 * What the view is told a Data View currently is.
 *
 * This is a plain reading of what the host already holds — it asks nothing, opens nothing and
 * decides nothing. Both hosts wrote it out themselves, identically but for the server's name and
 * the editor's dirty flag, and had already drifted: one kept an empty message and the other
 * dropped it. There is nothing here for a host to supply beyond the two fields above, which is
 * why it never needed to be written twice.
 */
export function dataViewState(of: DataViewStateOf): DataViewState {
  return {
    source: of.source,
    serverName: of.serverName,
    query: dataViewQueryInfo(of),
    projection: of.projection,
    status: of.status,
    ...(of.message === undefined ? {} : { message: of.message }),
    ...(of.payload === undefined ? {} : { payload: of.payload }),
    editability: of.editability,
    edits: [...of.edits.list],
    removedRows: [...of.edits.removedRows],
    addedRows: [...of.edits.addedRows],
    busy: of.busy,
    applying: of.edits.applying,
  };
}

/** What the view is told about the query: the shared model's reading of it, plus this view's own. */
function dataViewQueryInfo(of: DataViewStateOf): DataViewQueryInfo {
  const whereText = of.query.whereText();
  return {
    uri: of.queryUri,
    text: of.query.text,
    ...(whereText === undefined ? {} : { whereText }),
    orderBy: of.query.orderBy(),
    hidden: [...of.hidden.list],
    structured: of.query.analysis !== undefined,
    ...(of.query.problem === undefined ? {} : { problem: of.query.problem }),
    editorDirty: of.editorDirty,
  };
}
