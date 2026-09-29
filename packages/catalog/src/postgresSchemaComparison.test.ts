import { describe, expect, it, vi } from "vitest";
import {
  assemblePostgresStructureSql,
  comparePostgresStructures,
} from "./postgresSchemaComparison.js";

const document = (uri: string, content: string) => ({ uri, language: "sql" as const, content });

describe("PostgreSQL structural comparison", () => {
  it("assembles sources deterministically without preserving their file boundaries", () => {
    expect(
      assemblePostgresStructureSql([
        document("z/table.sql", "CREATE TABLE app.account (id bigint);\n"),
        document("a/schema.sql", "CREATE SCHEMA app;\n"),
      ]),
    ).toBe("CREATE SCHEMA app;\n\nCREATE TABLE app.account (id bigint);\n");
  });

  it("classifies the semantic Code Moniker verdict", async () => {
    const raw = {
      diagnostics: [],
      symbol_changes: [
        {
          kind: "removed",
          body_changed: false,
          signature_changed: false,
          header_changed: false,
          old: {
            identity: "code-moniker://p/schema:app/table:old",
            compact_identity: "sql:schema:app/table:old",
            file: "schema.sql",
            kind: "table",
            name: "old",
          },
        },
        {
          kind: "signature-changed",
          body_changed: false,
          signature_changed: true,
          header_changed: false,
          old: {
            identity: "code-moniker://p/schema:app/table:account/column:id",
            compact_identity: "sql:schema:app/table:account/column:id",
            file: "schema.sql",
            kind: "column",
            name: "id",
          },
          new: {
            identity: "code-moniker://p/schema:app/table:account/column:id",
            compact_identity: "sql:schema:app/table:account/column:id",
            file: "schema.sql",
            kind: "column",
            name: "id",
          },
        },
      ],
      ref_changes: [],
    } as const;
    const compare = vi.fn().mockResolvedValue(raw);

    const result = await comparePostgresStructures(
      { diffImpact: { compare } },
      [document("base/a.sql", "CREATE TABLE app.old (id bigint);")],
      [document("head/a.sql", "CREATE TABLE app.account (id integer);")],
      "installed..target",
    );

    expect(result.isomorphic).toBe(false);
    expect(result.onlyInBase).toEqual([
      { identity: "sql:schema:app/table:old", kind: "table", change: "removed" },
    ]);
    expect(result.changed).toEqual([
      {
        identity: "sql:schema:app/table:account/column:id",
        kind: "column",
        change: "signature-changed",
      },
    ]);
    expect(compare).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "installed..target",
        files: [expect.objectContaining({ status: "modified" })],
      }),
    );
  });

  it("compares structural signatures and reference targets independently of SQL formatting", async () => {
    const raw = {
      diagnostics: [],
      symbol_changes: [
        {
          kind: "body-modified",
          body_changed: true,
          signature_changed: false,
          old: {
            identity: "code-moniker://p/schema:app/index:account_email_idx",
            compact_identity: "sql:schema:app/index:account_email_idx",
            kind: "index",
            signature: "CREATE INDEX account_email_idx ON app.account(email)",
          },
          new: {
            identity: "code-moniker://p/schema:app/index:account_email_idx",
            compact_identity: "sql:schema:app/index:account_email_idx",
            kind: "index",
            signature: "CREATE INDEX account_email_idx ON app.account ( email )",
          },
        },
      ],
      ref_changes: [
        {
          kind: "call-site-retargeted",
          ref_kind: "member_of",
          old_source_compact: "sql:schema:app/index:account_email_idx",
          new_source_compact: "sql:schema:app/index:account_email_idx",
          old_target: "code-moniker://p/schema:app/table:account",
          new_target: "code-moniker://p/schema:app/table:account",
        },
        {
          kind: "ref-removed",
          ref_kind: "uses_type",
          old_target: "code-moniker://sdk/sql/text",
        },
        {
          kind: "ref-added",
          ref_kind: "uses_type",
          new_target: "code-moniker://sdk/sql/text",
        },
      ],
    } as const;
    const compare = vi.fn().mockResolvedValue(raw);

    const result = await comparePostgresStructures(
      { diffImpact: { compare } },
      [document("base/index.sql", "CREATE INDEX account_email_idx ON app.account(email);")],
      [
        document(
          "head/index.sql",
          "CREATE INDEX account_email_idx ON app.account USING btree (email);",
        ),
      ],
      "manifest..materialized",
      "structure",
    );

    expect(result.isomorphic).toBe(true);
    expect(result.changed).toEqual([]);
    expect(result.references).toEqual([]);
  });

  it("preserves token boundaries in structural signatures", async () => {
    const side = {
      identity: "code-moniker://p/schema:app/table:t/constraint:c",
      compact_identity: "sql:schema:app/table:t/constraint:c",
      kind: "constraint",
    };
    const compare = vi.fn().mockResolvedValue({
      diagnostics: [],
      ref_changes: [],
      symbol_changes: [
        {
          kind: "signature-changed",
          signature_changed: true,
          old: { ...side, signature: "CHECK (a IS NULL)" },
          new: { ...side, signature: "CHECK (aisnull)" },
        },
      ],
    });
    const result = await comparePostgresStructures(
      { diffImpact: { compare } },
      [],
      [],
      "tokens",
      "structure",
    );
    expect(result.isomorphic).toBe(false);
    expect(result.changed).toHaveLength(1);
  });

  it("pairs a PostgreSQL-generated constraint name with the same unnamed source constraint", async () => {
    const side = {
      file: "schema.sql",
      kind: "constraint",
      signature: "PRIMARY KEY (id)",
    };
    const raw = {
      diagnostics: [],
      symbol_changes: [
        {
          kind: "removed",
          old: {
            ...side,
            identity: "code-moniker://p/schema:app/table:account/constraint:42",
            compact_identity: "sql:schema:app/table:account/constraint:42",
          },
        },
        {
          kind: "added",
          new: {
            ...side,
            identity: "code-moniker://p/schema:app/table:account/constraint:account_pkey",
            compact_identity: "sql:schema:app/table:account/constraint:account_pkey",
          },
        },
      ],
      ref_changes: [],
    } as const;

    const result = await comparePostgresStructures(
      { diffImpact: { compare: vi.fn().mockResolvedValue(raw) } },
      [document("base/table.sql", "CREATE TABLE app.account (id bigint PRIMARY KEY);")],
      [
        document(
          "head/table.sql",
          "CREATE TABLE app.account (id bigint, CONSTRAINT account_pkey PRIMARY KEY (id));",
        ),
      ],
      "manifest..materialized",
      "structure",
    );

    expect(result.isomorphic).toBe(true);
    expect(result.onlyInBase).toEqual([]);
    expect(result.onlyInHead).toEqual([]);
  });

  it("pairs generated check names despite PostgreSQL expression rewriting", async () => {
    const raw = {
      diagnostics: [],
      symbol_changes: [
        {
          kind: "removed",
          old: {
            identity: "code-moniker://p/schema:app/table:account/constraint:42",
            compact_identity: "sql:schema:app/table:account/constraint:42",
            file: "schema.sql",
            kind: "constraint",
            signature: "CHECK (balance >= 0)",
          },
        },
        {
          kind: "added",
          new: {
            identity: "code-moniker://p/schema:app/table:account/constraint:account_balance_check",
            compact_identity: "sql:schema:app/table:account/constraint:account_balance_check",
            file: "schema.sql",
            kind: "constraint",
            signature: 'CONSTRAINT "account_balance_check" CHECK ((balance >= 0))',
          },
        },
      ],
      ref_changes: [],
    } as const;

    const result = await comparePostgresStructures(
      { diffImpact: { compare: vi.fn().mockResolvedValue(raw) } },
      [document("base/table.sql", "CREATE TABLE app.account (balance int CHECK (balance >= 0));")],
      [
        document(
          "head/table.sql",
          "CREATE TABLE app.account (balance int, CONSTRAINT account_balance_check CHECK ((balance >= 0)));",
        ),
      ],
      "manifest..materialized",
      "structure",
    );

    expect(result.isomorphic).toBe(true);
  });

  it("keeps type and default signature changes as structural differences", async () => {
    const raw = {
      diagnostics: [],
      symbol_changes: [
        {
          kind: "signature-changed",
          signature_changed: true,
          old: {
            identity: "code-moniker://p/schema:app/table:account/column:balance",
            compact_identity: "sql:schema:app/table:account/column:balance",
            kind: "column",
            signature: "balance integer DEFAULT 0",
          },
          new: {
            identity: "code-moniker://p/schema:app/table:account/column:balance",
            compact_identity: "sql:schema:app/table:account/column:balance",
            kind: "column",
            signature: "balance bigint DEFAULT 1",
          },
        },
      ],
      ref_changes: [],
    } as const;

    const result = await comparePostgresStructures(
      { diffImpact: { compare: vi.fn().mockResolvedValue(raw) } },
      [document("base/table.sql", "CREATE TABLE app.account (balance integer DEFAULT 0);")],
      [document("head/table.sql", "CREATE TABLE app.account (balance bigint DEFAULT 1);")],
      "manifest..materialized",
      "structure",
    );

    expect(result.isomorphic).toBe(false);
    expect(result.changed).toEqual([
      {
        identity: "sql:schema:app/table:account/column:balance",
        kind: "column",
        change: "signature-changed",
      },
    ]);
  });

  it("keeps an isolated NOT NULL addition as a structural difference", async () => {
    const raw = {
      diagnostics: [],
      symbol_changes: [
        {
          kind: "added",
          new: {
            identity: "code-moniker://p/schema:app/table:account/constraint:note.not_null",
            compact_identity: "sql:schema:app/table:account/constraint:note.not_null",
            kind: "constraint",
            signature: "NOT NULL",
          },
        },
      ],
      ref_changes: [],
    } as const;

    const result = await comparePostgresStructures(
      { diffImpact: { compare: vi.fn().mockResolvedValue(raw) } },
      [document("base/table.sql", "CREATE TABLE app.account (note text);")],
      [document("head/table.sql", "CREATE TABLE app.account (note text NOT NULL);")],
      "manifest..materialized",
      "structure",
    );

    expect(result.isomorphic).toBe(false);
    expect(result.onlyInHead).toEqual([
      {
        identity: "sql:schema:app/table:account/constraint:note.not_null",
        kind: "constraint",
        change: "added",
      },
    ]);
  });

  it("keeps renamed constraints when their complete structures differ", async () => {
    const constraintChange = (oldSignature: string, newSignature: string) => ({
      diagnostics: [],
      symbol_changes: [
        {
          kind: "removed",
          old: {
            identity: "code-moniker://p/schema:app/table:account/constraint:old_name",
            compact_identity: "sql:schema:app/table:account/constraint:old_name",
            kind: "constraint",
            signature: oldSignature,
          },
        },
        {
          kind: "added",
          new: {
            identity: "code-moniker://p/schema:app/table:account/constraint:new_name",
            compact_identity: "sql:schema:app/table:account/constraint:new_name",
            kind: "constraint",
            signature: newSignature,
          },
        },
      ],
      ref_changes: [],
    });
    for (const raw of [
      constraintChange("CHECK (balance > 0)", "CONSTRAINT new_name CHECK (balance < 0)"),
      constraintChange(
        "FOREIGN KEY (owner_id) REFERENCES app.owner(id)",
        "CONSTRAINT new_name FOREIGN KEY (owner_id) REFERENCES app.archived_owner(id)",
      ),
    ]) {
      const result = await comparePostgresStructures(
        { diffImpact: { compare: vi.fn().mockResolvedValue(raw) } },
        [document("base/table.sql", "CREATE TABLE app.account (balance integer);")],
        [document("head/table.sql", "CREATE TABLE app.account (balance integer);")],
        "manifest..materialized",
        "structure",
      );

      expect(result.isomorphic).toBe(false);
      expect(result.onlyInBase).toHaveLength(1);
      expect(result.onlyInHead).toHaveLength(1);
    }
  });

  it("keeps index body changes when their structural signatures differ", async () => {
    const raw = {
      diagnostics: [],
      symbol_changes: [
        {
          kind: "body-modified",
          body_changed: true,
          old: {
            identity: "code-moniker://p/schema:app/index:account_email_idx",
            compact_identity: "sql:schema:app/index:account_email_idx",
            kind: "index",
            signature: "CREATE INDEX account_email_idx ON app.account(email)",
          },
          new: {
            identity: "code-moniker://p/schema:app/index:account_email_idx",
            compact_identity: "sql:schema:app/index:account_email_idx",
            kind: "index",
            signature: "CREATE INDEX account_email_idx ON app.account(lower(email))",
          },
        },
      ],
      ref_changes: [],
    } as const;

    const result = await comparePostgresStructures(
      { diffImpact: { compare: vi.fn().mockResolvedValue(raw) } },
      [document("base/index.sql", "CREATE INDEX account_email_idx ON app.account(email);")],
      [document("head/index.sql", "CREATE INDEX account_email_idx ON app.account(lower(email));")],
      "manifest..materialized",
      "structure",
    );

    expect(result.isomorphic).toBe(false);
    expect(result.changed).toHaveLength(1);
  });

  it("keeps an index owner change as a structural difference", async () => {
    const raw = {
      diagnostics: [],
      symbol_changes: [],
      ref_changes: [
        {
          kind: "call-site-retargeted",
          ref_kind: "member_of",
          old_source_compact: "sql:schema:app/index:account_email_idx",
          new_source_compact: "sql:schema:app/index:account_email_idx",
          old_target_compact: "sql:schema:app/table:account",
          new_target_compact: "sql:schema:app/table:archived_account",
        },
      ],
    } as const;

    const result = await comparePostgresStructures(
      { diffImpact: { compare: vi.fn().mockResolvedValue(raw) } },
      [document("base/index.sql", "CREATE INDEX account_email_idx ON app.account(email);")],
      [
        document(
          "head/index.sql",
          "CREATE INDEX account_email_idx ON app.archived_account(email);",
        ),
      ],
      "manifest..materialized",
      "structure",
    );

    expect(result.isomorphic).toBe(false);
    expect(result.references).toHaveLength(1);
  });
});
