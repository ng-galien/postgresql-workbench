import { resolve } from "node:path";
import { Client, type ClientConfig } from "pg";
import { createCodeMonikerSyntaxParser } from "../src/analysis/codeMonikerSyntax.js";
import type { SyntaxParser } from "../src/analysis/syntaxTree.js";
import {
  ensureLocalCodeMonikerWorkspace,
  type LocalCodeMonikerSession,
} from "../src/workbench/localCodeMoniker.js";
import { readPostgresCatalog } from "../src/workbench/postgresCatalog.js";

export interface CodeMonikerTestRuntime {
  parser: SyntaxParser;
  sourceUris(connection: ClientConfig): Promise<Record<string, string>>;
  dapEnvironment(): NodeJS.ProcessEnv;
  dispose(): Promise<void>;
}

export async function startCodeMonikerTestRuntime(): Promise<CodeMonikerTestRuntime> {
  const runtimePath = process.env.CODE_MONIKER_RUNTIME
    ? resolve(process.env.CODE_MONIKER_RUNTIME)
    : undefined;
  const session: LocalCodeMonikerSession = await ensureLocalCodeMonikerWorkspace({
    runtimePath,
    workspaceRoots: [process.cwd()],
    clientName: "postgresql-workbench-e2e",
  });
  return {
    parser: createCodeMonikerSyntaxParser(session.client),
    sourceUris: async (connection) => {
      const client = new Client(connection);
      await client.connect();
      try {
        const serverId = `${connection.host}:${connection.port}/${connection.database}:${connection.user}`;
        const catalog = await readPostgresCatalog(client, {
          serverId,
          database: String(connection.database),
        });
        await waitForReady(session);
        await session.client.sources.replace({
          ...catalog.sourceSet,
          documents: catalog.sourceSet.documents.map(({ uri, language, content }) => ({
            uri,
            language,
            content,
          })),
        });
        await waitForReady(session);

        const documents = new Map(
          catalog.sourceSet.documents.map((document) => [document.uri, document]),
        );
        const sourceUris: Record<string, string> = {};
        let cursor: unknown | null = null;
        do {
          const page = await session.client.symbols.search(
            {
              language: ["sql"],
              kind: ["function", "procedure"],
              path: [
                `postgresql://${encodeURIComponent(serverId)}/${encodeURIComponent(String(connection.database))}/**`,
              ],
            },
            { consistency: "stale_ok", limit: 500, cursor },
          );
          for (const symbol of page.data.rows) {
            const descriptor = documents.get(symbol.file)?.postgres;
            if (descriptor?.documentKind === "routine") {
              sourceUris[String(descriptor.oid)] = symbol.uri;
            }
          }
          cursor = page.nextCursor;
        } while (cursor !== null);
        return sourceUris;
      } finally {
        await client.end();
      }
    },
    dapEnvironment: () => ({
      ...process.env,
      ...(runtimePath
        ? { PLPGSQL_CODE_MONIKER_RUNTIME: session.metadata.runtimePath }
        : { PLPGSQL_CODE_MONIKER_RUNTIME: undefined }),
    }),
    dispose: () => session.dispose(),
  };
}

async function waitForReady(session: LocalCodeMonikerSession): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (true) {
    const status = await session.client.workspace.status();
    if (status.phase === "ready") return;
    if (status.phase === "failed") {
      throw new Error(status.failure?.message ?? "Code Moniker indexing failed");
    }
    if (Date.now() >= deadline) {
      throw new Error(`Code Moniker remained ${status.phase} while indexing PostgreSQL sources`);
    }
    await new Promise((resolveReady) => setTimeout(resolveReady, 50));
  }
}
