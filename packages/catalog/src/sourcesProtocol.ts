/**
 * What the Sources view and its host send each other: the virtual sources the catalog projects,
 * and one of them opened as a canonical SQL document. The protocol lives with the engine that
 * owns the sources — a host adapts to it, whichever shell it is.
 */

export interface SourcesListItem {
  uri: string;
  schema: string;
  name: string;
  kind: string;
}

export type SourcesRequest = { type: "sources/ready" } | { type: "sources/open"; uri: string };

export type SourcesResponse =
  | { type: "sources/list"; items: SourcesListItem[] }
  | {
      type: "sources/source";
      uri: string;
      editorUri: string;
      title: string;
      text: string;
      languageId: string;
    }
  | { type: "sources/notice"; message: string; severity: "info" | "error" };
