import { Client } from "pg";
import { readPostgresCatalog, type VirtualSqlDocument } from "../../catalog/src/postgresCatalog.js";
import type {
  SourcesListItem,
  SourcesRequest,
  SourcesResponse,
} from "../../catalog/src/sourcesProtocol.js";
import { postgresSourceLanguageId } from "../../sql/src/text/documentLanguage.js";

/**
 * The Sources view's host: the virtual sources the catalog projects, read in a browser.
 *
 * These are the same documents every shell serves into its own document system — VS Code as
 * `code+moniker://` tabs, this page as a list — and the same stream colours them everywhere:
 * nothing here decides what a source means. The catalog answers what exists and what it says; the
 * language server answers what its pieces and names are, through the client the Data View host
 * already holds.
 */

export interface SourcesHost {
  handle(request: SourcesRequest): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * How a virtual source is named in the list: its descriptor when it has one, its uri otherwise.
 * The uri encodes what a path cannot carry — `fib(n%20integer)` — and a reader is shown the
 * signature, not its escapes.
 */
function listItem(document: VirtualSqlDocument): SourcesListItem {
  const tail = document.uri.split("/").at(-1) ?? document.uri;
  return {
    uri: document.uri,
    schema: document.postgres?.schema ?? "",
    name: decodeURIComponent(tail.replace(/\.sql$/u, "")),
    kind: document.postgres?.documentKind ?? "source",
  };
}

export async function startSourcesHost(options: {
  connection: { host: string; port: number; user: string; password: string; database: string };
  emit(response: SourcesResponse): void;
}): Promise<SourcesHost> {
  const identity = {
    connectionId: `${options.connection.host}:${options.connection.port}`,
    database: options.connection.database,
  };
  const documents = new Map<string, VirtualSqlDocument>();

  const load = async () => {
    const client = new Client(options.connection);
    await client.connect();
    try {
      const catalog = await readPostgresCatalog(client, identity);
      documents.clear();
      for (const document of catalog.sourceSet.documents) documents.set(document.uri, document);
    } finally {
      await client.end().catch(() => {});
    }
  };

  return {
    async handle(request) {
      try {
        switch (request.type) {
          case "sources/ready": {
            if (documents.size === 0) await load();
            const items = [...documents.values()].map(listItem);
            items.sort((a, b) => a.uri.localeCompare(b.uri));
            options.emit({ type: "sources/list", items });
            return;
          }
          case "sources/open": {
            const document = documents.get(request.uri);
            if (!document) {
              options.emit({
                type: "sources/notice",
                message: `${request.uri} is not in the catalog any more.`,
                severity: "error",
              });
              return;
            }
            const named = listItem(document);
            options.emit({
              type: "sources/source",
              uri: document.uri,
              editorUri: `file:///postgresql-workbench/sources/${encodeURIComponent(document.uri)}.sql`,
              title: named.schema ? `${named.schema}.${named.name}` : named.name,
              text: document.content,
              languageId: postgresSourceLanguageId(named.kind, document.postgres?.routineKind),
            });
            return;
          }
        }
      } catch (error) {
        options.emit({
          type: "sources/notice",
          message: error instanceof Error ? error.message : String(error),
          severity: "error",
        });
      }
    },
    async dispose() {
      documents.clear();
    },
  };
}
