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
npm install --save-exact @ng-galien/postgresql-catalog@0.1.4
npm ci
```

For local development, `npm run test:catalog:package` in the Workbench checkout
creates a versioned `.tgz`, prints its path and integrity, and proves an isolated
installation followed by `npm ci`. Copy that tarball into the consumer's
`vendor/` directory and install it with
`npm install --save-exact ./vendor/ng-galien-postgresql-catalog-0.1.4.tgz`.
Commit both the tarball and lockfile for reproducibility. This local archive
reference requires no adjacent Workbench checkout. A registry dependency should
replace it when the package is published.

The package check also compiles a consumer against the real published Code
Moniker 0.13.0 declarations and runs its parser and a manifest/catalog comparison.
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
  on inline or table-level primary keys in `CREATE TABLE`. This includes
  composite and quoted keys. Other nullability changes remain differences.
  Without a parser, or for incomplete syntax, comparison remains conservative.
  Primary keys introduced through `ALTER TABLE` are not normalized by this pass.
  Broader manifest/catalog comparisons involving sequential `ALTER TABLE`,
  constraint signatures and explicit default index methods require Code Moniker
  0.13 or later; a less capable provider can report conservative differences.

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
