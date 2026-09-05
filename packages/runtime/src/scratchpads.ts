import { randomUUID } from "node:crypto";
import { runBoundedQuery } from "../../dap/src/debugger/launch/boundedQueryResult.js";
import type { SqlNotebookFile } from "../../scratchpad/src/notebookFile.js";
import type { EvidenceStore } from "./evidence.js";
import type { DatabaseSessions } from "./sessions.js";

export interface RuntimeScratchpad {
  id: string;
  sessionId: string;
  revision: number;
  document: SqlNotebookFile;
}

export class ScratchpadSessions {
  private readonly documents = new Map<string, RuntimeScratchpad>();

  constructor(
    private readonly sessions: DatabaseSessions,
    private readonly evidence: EvidenceStore,
  ) {}

  put(
    sessionId: string,
    cells: string[],
    id?: string,
    expectedRevision?: number,
  ): RuntimeScratchpad {
    const context = this.sessions.context(sessionId);
    const existing = id ? this.read(id) : undefined;
    if (existing && (existing.sessionId !== sessionId || existing.revision !== expectedRevision)) {
      throw new Error("Scratchpad session or revision mismatch; read it before editing.");
    }
    if (!existing && this.documents.size >= 100) throw new Error("Scratchpad limit reached.");
    const document: RuntimeScratchpad = {
      id: id ?? randomUUID(),
      sessionId,
      revision: (existing?.revision ?? 0) + 1,
      document: {
        version: 1,
        metadata: { connectionId: sessionId, database: context.database },
        cells: cells.map((source) => ({ kind: "code", language: "plpgsql", source })),
      },
    };
    this.documents.set(document.id, document);
    return structuredClone(document);
  }

  read(id: string): RuntimeScratchpad {
    const document = this.documents.get(id);
    if (!document) throw new Error("Unknown scratchpad id.");
    return structuredClone(document);
  }

  list() {
    return [...this.documents.values()].map(({ id, sessionId, revision }) => ({
      id,
      sessionId,
      revision,
    }));
  }

  async execute(id: string, revision: number, cellIndex: number) {
    const scratchpad = this.read(id);
    if (scratchpad.revision !== revision) throw new Error("Scratchpad revision mismatch.");
    const cell = scratchpad.document.cells[cellIndex];
    if (!cell) throw new Error("Unknown scratchpad cell.");
    const context = this.sessions.context(scratchpad.sessionId);
    return this.sessions.exclusive(context.id, async (client) => {
      const releaseCapacity = this.evidence.reserve(1024 * 1024);
      const startedAt = new Date().toISOString();
      const start = Date.now();
      const source = {
        name: `Scratchpad ${id}, cell ${cellIndex}`,
        uri: `workbench://scratchpads/${id}#${cellIndex}`,
      };
      const provenance = {
        context,
        scratchpadId: id,
        revision,
        cellIndex,
        sql: cell.source,
        startedAt,
      };
      try {
        const result = await runBoundedQuery(client, cell.source, [], {
          id: randomUUID(),
          singleStatement: true,
          source,
          maxRows: 200,
          maxPayloadBytes: 256 * 1024,
        });
        releaseCapacity();
        return this.evidence.capture(context.id, "execution", {
          ...provenance,
          status: "completed",
          result,
        });
      } catch (error) {
        releaseCapacity();
        const failure = error as { message?: string; code?: string; position?: string };
        return this.evidence.capture(context.id, "execution", {
          ...provenance,
          status: "failed",
          durationMs: Date.now() - start,
          error: {
            message: (failure.message ?? "Execution failed").slice(0, 10_000),
            code: failure.code,
            position: failure.position,
          },
        });
      }
    });
  }
}
