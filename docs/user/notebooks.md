---
title: SQL scratchpads
description: Keep exploratory SQL persistent and correctly bound.
eyebrow: SQL scratchpads
media: notebook.gif
mediaAlt: SQL scratchpad executing a query and showing a PostgreSQL result grid
---

# Keep exploratory SQL persistent and correctly bound.

A scratchpad is a VS Code notebook with an explicit NotebookBinding. It does
not silently follow whichever database happens to be active.

{{media}}

## Create and bind

1. Select a DatabaseContext in the Workbench tree.
2. Run **PostgreSQL Workbench: New SQL Scratchpad**.
3. Add SQL and Markdown cells, then run one cell or the whole notebook.

The notebook header, cells, inlays, and results use its persisted binding.
**Use Binding as Active** is an explicit promotion; ordinary execution never
switches the global context. If the connection disappears, editing remains
available while Run offers Reconnect or Rebind.

## Result navigation

Read-only queries use a dedicated PostgreSQL cursor. The first page and each
Next action load `postgresql-workbench.results.pageSize` rows (200 by default).
Previous uses the bounded local cache. Load all is an explicit decision that
bypasses the cache limit.

Statements that cannot be paged safely, including data-changing statements
with `RETURNING`, use the separate `nonPagedMaxRows` limit. Copy and export
disclose truncation and require confirmation for incomplete previews.

> The limits protect the Workbench UI, not PostgreSQL itself. An intentionally
> huge Load all can still consume substantial memory.

## Result values and export

Sort columns in the result header. Scalar values remain lightweight text; JSON,
binary, and truncated values open an inspector. PostgreSQL `NULL` remains
distinct from an empty string. CSV and TSV exports neutralize spreadsheet
formulas.

The relevant page size, cache, cursor timeout, and non-paged limits are listed
in the [settings reference](reference.md).
