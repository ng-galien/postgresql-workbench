# PostgreSQL catalog projection

`@ng-galien/postgresql-catalog` reads a PostgreSQL catalog into deterministic
virtual SQL documents and compares two structural projections through Code
Moniker. It is the reusable schema authority shared by PostgreSQL Workbench and
database upgrade consumers.

The projection covers schemas, enum types, tables, columns, named constraints,
column comments, explicit indexes, views, routines and triggers. Roles,
privileges and application data remain outside this structural model.

## Installation

Requires Node.js 22 or later. The package is ESM and includes TypeScript
declarations under its root export. It has no runtime npm dependencies: callers
provide the database connection and, for comparisons, a Code Moniker client.
The package is licensed under MIT (see `LICENSE`).

A `catalog-v<version>` tag launches the package validation and npm publication
workflow described in the repository release guide. Install
an exact version and commit the consumer lockfile:

```sh
npm install --save-exact @ng-galien/postgresql-catalog@0.1.7
npm ci
```

For local development, `npm run test:catalog:package` in the Workbench checkout
creates a versioned `.tgz`, prints its path and integrity, and proves an isolated
installation followed by `npm ci`. Copy that tarball into the consumer's
`vendor/` directory and install it with
`npm install --save-exact ./vendor/ng-galien-postgresql-catalog-0.1.7.tgz`.
Commit both the tarball and lockfile for reproducibility. This local archive
reference requires no adjacent Workbench checkout. A registry dependency should
replace it when the package is published.

The package check also compiles a consumer against the real published Code
Moniker 0.14.1 declarations and runs its parser and a manifest/catalog comparison.
This compatibility phase installs the client from its own committed lockfile
and requires npm access; the catalog-only install above is still tested offline.

## Public API

```ts
import { readPostgresCatalog, assemblePostgresStructureSql }
  from '@ng-galien/postgresql-catalog';
import type { CatalogQueryClient } from '@ng-galien/postgresql-catalog';

export async function inspect(client: CatalogQueryClient) {
  const snapshot = await readPostgresCatalog(client, {
    connectionId: 'application',
    database: 'application',
  });
  return assemblePostgresStructureSql(snapshot.sourceSet.documents);
}
```

`client.query(sql)` must return `{ rows: Record<string, unknown>[] }` and use
an already connected PostgreSQL session. The caller owns credentials and
connection disposal. Reading the catalog does not execute migrations.

- `readPostgresCatalog` returns the catalog model, virtual SQL source set,
  origins, relationships and timing metrics.
- `readPostgresCatalogDocuments` returns a patch for selected document URIs
  and optional new resources. Catch `PostgresCatalogFullRefreshRequired` to
  retry with a full snapshot when resource mappings are unavailable.
- `assemblePostgresStructureSql` produces deterministic SQL from documents.
- `comparePostgresStructures(client, base, head, scope, mode?, parser?)` delegates to
  the supplied `CodeMonikerStructureComparisonClient.diffImpact.compare`.
  The default `semantic` mode retains semantic changes; `structure` applies
  the projection's narrower structural filters. Neither verdict certifies
  migration safety or data preservation. Diagnostics prevent an isomorphic
  verdict. This package does not create a Code Moniker transport or daemon.
- `createCodeMonikerSyntaxParser(client)` adapts an existing client's `queryData`
  method to the exported `SyntaxParser` port. It does not open a connection.
  Pass this parser to structural comparisons to recognize implicit `NOT NULL`
  on inline or table-level primary keys and identity columns in `CREATE TABLE`.
  This includes composite and quoted keys and tables nested in `CREATE SCHEMA`.
  Other nullability changes remain differences.
  Without a parser, comparison remains conservative. With a parser, invalid
  syntax or an incomplete statement outline/table tree fails explicitly.
  Large schemas use a shallow, coverage-checked statement outline and complete
  table trees, so routine bodies do not fill the syntax response. The original
  complete SQL and statement order still reach the structural comparison.
  Primary keys introduced through `ALTER TABLE` are not normalized by this pass.
  Broader manifest/catalog comparisons involving sequential `ALTER TABLE`,
  constraint signatures and explicit default index methods require Code Moniker
  0.13 or later; a less capable provider can report conservative differences.

With a syntax parser, structural comparison also proves bounded expression
equivalences: redundant expression parentheses, quoted identifier spelling,
literal casts to a proven contextual type, literal `IN` lists materialized as
`= ANY (ARRAY[...])`, and the implicit null branch of a `CASE` with a proven
result type. Operator nesting, literal contents, significant casts and changed
branches remain distinct. Type proofs use declarations and `search_path`;
unknown schemas, shadowing and unsupported forms retain differences. These
rules do not canonicalize schemas by executing SQL against a temporary database.
Syntax analysis uses the provider's default response budget. The parser checks
coverage of all statements across consecutive requests and reads function names
in smaller groups when needed. The structural comparison still receives the
complete SQL with statement order preserved.

Contextual proofs currently require a closed set of declarative statements.
Unmodeled effects such as `ALTER TABLE`, `DROP`, `RESET`, `DO` and SQL execution
disable type-dependent simplifications on both sides of the comparison.
Conditional definitions, nested schema definitions and ambiguous resolution
also remain unproven. When differences remain, diagnostics identify the
unsupported statement and its byte position. This is a proof limitation, not
evidence of a real schema mismatch; it still prevents an isomorphic verdict.
An arbitrary migration manifest is therefore not yet fully qualified by these
expression proofs, even when its catalog projection uses only declarations.

Code Moniker 0.13 has known limitations in generated-column attribute identities,
literal whitespace signatures and generic SQL operator precedence. The regression
suite retains negative cases for these defects. The complete application gate
must pass against the corrected published provider before release qualification.

```ts
import { comparePostgresStructures, createCodeMonikerSyntaxParser }
  from '@ng-galien/postgresql-catalog';

// Reuse the application's existing Code Moniker client and transport.
const parser = createCodeMonikerSyntaxParser(codeMoniker);
const comparison = await comparePostgresStructures(
  codeMoniker, manifestDocuments, catalogDocuments, 'manifest..catalog',
  'structure', parser,
);
```

Import only from the package root; internal paths are not public contracts.

## Full schema validation

The package gate compares a schema larger than 500 KB using the published
Code Moniker client. To additionally validate an application's complete schema,
provide a JSON file with `name`, `base` and `head` (the two arrays of virtual SQL
documents) and run:

```sh
CATALOG_SCHEMA_CASE=/path/to/schema-case.json \
CATALOG_SCHEMA_REPORT=/path/to/comparison-result.json \
npm run test:catalog:package
```

The report retains every difference and diagnostic. A non-isomorphic result
fails the gate; completing a large comparison does not certify equivalence.

For upstream development only, `CATALOG_TEST_CODE_MONIKER_BINARY` selects an
explicit local native test binary for the comparison tests and package gate.
This does not replace the final gate with the installed published provider.
