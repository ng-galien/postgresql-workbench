import { describe, expect, it } from "vitest";
import type { PostgresDocumentSyntaxFacts } from "../analysis/documentFacts.js";
import { postgresAnalysisIdentity } from "../analysis/postgresSyntax.js";
import type { PostgresSyntaxExpectationProvider } from "../analysis/syntaxExpectations.js";
import type { SqlAuthoringSnapshot } from "../snapshot.js";
import { planSqlAuthoringCompletionRequest } from "./completionRequest.js";
import type { SqlAuthoringHostServices } from "./hostServices.js";

const SNAPSHOT: SqlAuthoringSnapshot = {
  status: "available",
  connectionId: "test",
  database: "test",
  revision: "1",
  generation: 1,
  objects: [],
  foreignKeys: [],
};

describe("planSqlAuthoringCompletionRequest", () => {
  it("fails closed before prediction when syntax facts belong to another same-length source", async () => {
    const parsedSource = "SELECT p. FROM item AS p";
    const currentSource = "SELECT q. FROM item AS p";
    let predictionRequested = false;
    const host = {
      async syntax() {
        return { hasError: true, truncated: false, facts: facts(parsedSource, "sql") };
      },
    } as Pick<SqlAuthoringHostServices, "syntax">;
    const expectations: PostgresSyntaxExpectationProvider = {
      async expectedSyntax() {
        predictionRequested = true;
        throw new Error("prediction must not be requested for stale facts");
      },
    };

    const result = await planSqlAuthoringCompletionRequest(
      {
        uri: "file:///stale.sql",
        source: currentSource,
        language: "sql",
        offset: 9,
        snapshot: SNAPSHOT,
      },
      host,
      expectations,
    );

    expect(predictionRequested).toBe(false);
    expect(result).toMatchObject({ status: "unavailable", reason: "analysis-identity-mismatch" });
  });

  it("rejects PL/pgSQL facts returned for a SQL request", async () => {
    const source = "BEGIN NULL; END";
    const host = {
      async syntax() {
        return { hasError: false, truncated: false, facts: facts(source, "plpgsql") };
      },
    } as Pick<SqlAuthoringHostServices, "syntax">;
    const expectations: PostgresSyntaxExpectationProvider = {
      async expectedSyntax() {
        throw new Error("prediction must not cross the language boundary");
      },
    };

    await expect(
      planSqlAuthoringCompletionRequest(
        {
          uri: "file:///wrong-language.sql",
          source,
          language: "sql",
          offset: 0,
          snapshot: SNAPSHOT,
        },
        host,
        expectations,
      ),
    ).resolves.toMatchObject({ status: "unavailable", reason: "region-language-mismatch" });
  });

  it("fails closed when the active region is erroneous and has no grammar-proven repair", async () => {
    const source = "SELECT broken FROM";
    const erroneous = facts(source, "sql");
    erroneous.shape.root.hasError = true;
    const host = {
      async syntax() {
        return { hasError: true, truncated: false, facts: erroneous };
      },
    } as Pick<SqlAuthoringHostServices, "syntax">;
    const expectations: PostgresSyntaxExpectationProvider = {
      async expectedSyntax(request) {
        return {
          status: "unavailable",
          reason: "provider-capability-missing",
          regionId: request.regionId,
          target: request.target,
        };
      },
    };

    await expect(
      planSqlAuthoringCompletionRequest(
        {
          uri: "file:///erroneous.sql",
          source,
          language: "sql",
          offset: source.length,
          snapshot: SNAPSHOT,
        },
        host,
        expectations,
      ),
    ).resolves.toMatchObject({ status: "unavailable", reason: "region-syntax-error" });
  });
});

function facts(source: string, language: "sql" | "plpgsql"): PostgresDocumentSyntaxFacts {
  const id = `${language}:root:0-${source.length}`;
  const range = { start: 0, end: source.length };
  const target =
    language === "sql"
      ? ({ language: "sql", entryPoint: "script" } as const)
      : ({ language: "plpgsql", entryPoint: "block" } as const);
  return {
    shape: {
      root: {
        id,
        language,
        kind: "document",
        target: { status: "available", target },
        hasError: false,
        sourceRange: range,
        analysisSource: source,
        analysisIdentity: postgresAnalysisIdentity(source),
        projection: { kind: "identity", documentRange: range, analysisRange: range },
        children: [],
      },
      truncated: false,
    },
    scopes: [{ id, regionId: id, language, kind: "language-region", range }],
    lexical: [],
    names: [],
  };
}
