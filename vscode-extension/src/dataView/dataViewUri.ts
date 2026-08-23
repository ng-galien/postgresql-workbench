import * as vscode from "vscode";
import type { DataViewSource } from "../../../packages/rows/src/dataView/dataView.js";
import { DATA_VIEW_QUERY_SCHEME } from "./queryFileSystem.js";

export const DATA_VIEW_URI_SCHEME = "postgresql-workbench-data";
export const DATA_VIEW_EDITOR_VIEW_TYPE = "postgresql-workbench.dataView";

const MAX_LABEL_CHARS = 60;

/** Tab title for a SQL-backed Data View: the statement on one line, bounded. */
export function dataViewSqlLabel(sql: string): string {
  const flat = sql.replace(/\s+/gu, " ").trim().replace(/;$/u, "");
  return flat.length > MAX_LABEL_CHARS ? `${flat.slice(0, MAX_LABEL_CHARS - 1)}…` : flat || "Query";
}

function pathSegment(value: string): string {
  return value.replace(/[/\\]/gu, "∕");
}

/**
 * Encodes a Data View source in its URI: the path carries the tab title, the query carries the
 * complete source so a restored editor can reopen the same view.
 */
export function dataViewUri(source: DataViewSource): vscode.Uri {
  const title = source.kind === "relation" ? `${source.schema}.${source.name}` : source.label;
  const encoded = Buffer.from(JSON.stringify(source), "utf8").toString("base64url");
  return vscode.Uri.from({
    scheme: DATA_VIEW_URI_SCHEME,
    path: `/${pathSegment(source.serverId)}/${pathSegment(source.database)}/${pathSegment(title)}`,
    query: `source=${encoded}`,
  });
}

/** The writable SQL document that drives a Data View. */
export function dataViewQueryUri(source: DataViewSource): vscode.Uri {
  const title = source.kind === "relation" ? `${source.schema}.${source.name}` : source.label;
  return vscode.Uri.from({
    scheme: DATA_VIEW_QUERY_SCHEME,
    path: `/${pathSegment(source.serverId)}/${pathSegment(source.database)}/${pathSegment(title)}.sql`,
  });
}

/**
 * A hidden sibling of the query document, never shown to a reader: one per question asked about
 * the query, because the questions are asked at the same moment about texts that differ — a draft
 * with a caret in it for completion, the query as it stands for colouring, a draft again for
 * colouring the filter. One document could only answer the last one asked.
 */
export function dataViewScratchUri(source: DataViewSource, purpose: DataViewScratch): vscode.Uri {
  const query = dataViewQueryUri(source);
  return query.with({ path: query.path.replace(/\.sql$/u, `.${purpose}.sql`) });
}

export type DataViewScratch = "completion" | "tokens" | "filter-tokens";

/** Every scratch document of a Data View, for opening and for letting go of all of them. */
export const DATA_VIEW_SCRATCHES: readonly DataViewScratch[] = [
  "completion",
  "tokens",
  "filter-tokens",
];

export function parseDataViewUri(uri: vscode.Uri): DataViewSource | undefined {
  if (uri.scheme !== DATA_VIEW_URI_SCHEME) return undefined;
  const encoded = new URLSearchParams(uri.query).get("source");
  if (!encoded) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    return isDataViewSource(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isDataViewSource(value: unknown): value is DataViewSource {
  if (!value || typeof value !== "object") return false;
  const source = value as Record<string, unknown>;
  if (typeof source.serverId !== "string" || typeof source.database !== "string") return false;
  if (source.kind === "relation") {
    return (
      typeof source.schema === "string" &&
      typeof source.name === "string" &&
      (source.relationKind === "table" ||
        source.relationKind === "view" ||
        source.relationKind === "materialized-view")
    );
  }
  return (
    source.kind === "sql" && typeof source.sql === "string" && typeof source.label === "string"
  );
}
