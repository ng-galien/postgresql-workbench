import { createHash } from "node:crypto";
import { readPostgresCatalog, type VirtualSqlDocument } from "../../catalog/src/postgresCatalog.js";
import type { EvidenceStore } from "./evidence.js";
import type { DatabaseSessions } from "./sessions.js";

/** Explicit structural observations; row contents never participate in the comparison. */
export class CatalogObservations {
  private readonly previous = new Map<string, Map<string, string>>();

  constructor(
    private readonly sessions: DatabaseSessions,
    private readonly evidence: EvidenceStore,
  ) {}

  async refresh(sessionId: string) {
    const context = this.sessions.context(sessionId);
    return this.sessions.exclusive(sessionId, async (client) => {
      const snapshot = await readPostgresCatalog(client, {
        connectionId: sessionId,
        database: context.database,
      });
      const documents = snapshot.sourceSet.documents;
      const current = new Map(documents.map((doc) => [doc.uri, hash(doc)]));
      const previous = this.previous.get(sessionId);
      const changes = {
        initial: !previous,
        added: documents.filter((doc) => !previous?.has(doc.uri)).map((doc) => doc.uri),
        changed: documents
          .filter((doc) => previous?.has(doc.uri) && previous.get(doc.uri) !== current.get(doc.uri))
          .map((doc) => doc.uri),
        removed: [...(previous?.keys() ?? [])].filter((uri) => !current.has(uri)),
      };
      const result = this.evidence.capture(sessionId, "catalog", {
        context,
        revision: snapshot.sourceSet.revision,
        documents,
        foreignKeys: snapshot.foreignKeys,
        viewDependencies: snapshot.viewDependencies,
        changes,
      });
      this.previous.set(sessionId, current);
      return result;
    });
  }
}

function hash(document: VirtualSqlDocument): string {
  return createHash("sha256").update(document.content).digest("hex");
}
