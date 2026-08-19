import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  SemanticTokensLegend: class {
    constructor(
      readonly tokenTypes: string[],
      readonly tokenModifiers: string[],
    ) {}
  },
  EventEmitter: class {
    readonly event = () => ({ dispose() {} });
    fire() {}
  },
  SemanticTokensBuilder: class {},
}));

import {
  sqlAuthoringLanguageStatus,
  sqlAuthoringRejectionAction,
} from "../authoring/languageStatus.js";
import { TOKEN_MODIFIERS, TOKEN_TYPES } from "../authoring/plpgsqlTokenLegend.js";
import {
  SQL_SEMANTIC_TOKEN_MODIFIERS,
  SQL_SEMANTIC_TOKEN_TYPES,
} from "../authoring/semanticTokens.js";
import { formatSkippedMessage, wantsPlpgsqlSemanticTokens } from "./policy.js";
import { decodeSemanticTokenData } from "./protocol.js";

describe("SQL authoring server policy", () => {
  it("keeps the PL/pgSQL legend as a prefix of the SQL authoring legend", () => {
    expect([...SQL_SEMANTIC_TOKEN_TYPES].slice(0, TOKEN_TYPES.length)).toEqual([...TOKEN_TYPES]);
    expect([...SQL_SEMANTIC_TOKEN_MODIFIERS]).toEqual([...TOKEN_MODIFIERS]);
  });

  it("decodes delta-encoded semantic tokens into absolute positions", () => {
    expect(decodeSemanticTokenData([0, 2, 3, 0, 1, 0, 5, 4, 2, 0, 2, 1, 6, 3, 0])).toEqual([
      { line: 0, character: 2, length: 3, tokenType: 0, tokenModifiers: 1 },
      { line: 0, character: 7, length: 4, tokenType: 2, tokenModifiers: 0 },
      { line: 2, character: 1, length: 6, tokenType: 3, tokenModifiers: 0 },
    ]);
  });

  it("requests PL/pgSQL tokens only for .pgsql files", () => {
    expect(wantsPlpgsqlSemanticTokens("file:///a.pgsql", "plpgsql")).toBe(true);
    expect(wantsPlpgsqlSemanticTokens("file:///a.sql", "sql")).toBe(false);
    expect(wantsPlpgsqlSemanticTokens("vscode-notebook-cell:///a#x", "plpgsql")).toBe(false);
  });

  it("explains why Format Document was skipped", () => {
    expect(formatSkippedMessage({ hasError: false, truncated: false })).toBeUndefined();
    expect(formatSkippedMessage({ hasError: true, truncated: false, errorLine: 4 })).toContain(
      "line 4",
    );
    expect(formatSkippedMessage({ hasError: false, truncated: true })).toContain(
      "postgresql-workbench.sqlAuthoring.syntaxMaxDepth",
    );
    expect(formatSkippedMessage({ hasError: true, truncated: false, plpgsqlBody: true })).toContain(
      "bare PL/pgSQL",
    );
  });

  it("presents the authoring context and its recovery command", () => {
    expect(
      sqlAuthoringLanguageStatus({
        context: { status: "unassociated", message: "This SQL document has no Association." },
        documentUri: "file:///q.sql",
        scope: "document",
      }),
    ).toMatchObject({
      text: "No Document Association",
      severity: "warning",
      command: {
        command: "postgresql-workbench.assignDocumentConnection",
        arguments: [{ documentUri: "file:///q.sql" }],
      },
    });
    expect(
      sqlAuthoringLanguageStatus({
        context: { status: "not-indexed", message: "not indexed" },
        documentUri: "vscode-notebook-cell:///s#1",
        scope: "scratchpad",
        connexionName: "dev",
      }),
    ).toMatchObject({ text: "Index missing for dev", command: { title: "Reindex" } });
  });

  it("offers an actionable follow-up for composition rejections", () => {
    expect(sqlAuthoringRejectionAction("syntax-budget", "file:///q.sql", "document")).toMatchObject(
      { command: "workbench.action.openSettings" },
    );
    expect(sqlAuthoringRejectionAction("stale", "file:///q.sql", "document")).toMatchObject({
      command: "postgresql-workbench.indexDatabase",
    });
    expect(sqlAuthoringRejectionAction("unassociated", "file:///q.sql", "document")).toMatchObject({
      command: "postgresql-workbench.assignDocumentConnection",
    });
    expect(
      sqlAuthoringRejectionAction("syntax-error", "file:///q.sql", "document"),
    ).toBeUndefined();
  });
});
