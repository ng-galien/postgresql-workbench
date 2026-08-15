---
title: SQL Scratchpads
description: Create, associate, and run SQL Scratchpads.
eyebrow: SQL scratchpads
media: notebook.gif
mediaAlt: SQL scratchpad executing a query and showing a PostgreSQL result grid
---

# SQL Scratchpads

A Scratchpad is a persistent SQL workspace. Its Association points to a saved
Connexion, never to a live PostgreSQL session, and never silently follows the
active DatabaseContext.

{{media}}

## Create and associate

The PostgreSQL Workbench sidebar keeps the database tree above a separate,
resizable **Scratchpads** view. Create a Scratchpad with the **New SQL
Scratchpad** action in that view header. The initial Association depends on the
saved Connexions:

- with no saved Connexion, the Scratchpad is created without an Association;
- with one saved Connexion, the Association is automatic;
- with several saved Connexions, a selector includes **No connection**;
- cancelling that selector still creates the Scratchpad without an Association.

Use the **Filter SQL Scratchpads** action in the view header to narrow the tree
by Scratchpad name or Association. Submit an empty filter to restore the full
list; **Refresh SQL Scratchpads** preserves the active filter.

The Scratchpad header, cells, inlays, and results use its persistent Association.
Completion and query composition follow that same Association. Formatting uses
PostgreSQL syntax without consulting a database context; see [SQL
authoring](sql-authoring.md).
**Use Association as Active** is an explicit promotion; ordinary execution never
switches the active DatabaseContext. If the Connexion disappears, editing remains
available while execution offers Reconnect or Change Association.

## Mode and Transaction

Every Scratchpad persists one Mode:

- **Mode AUTO** runs each execution on a dedicated, short-lived PostgreSQL session;
- **Mode MANUAL** opens one Transaction on the first executed Statement and keeps
  that Transaction attached to the Scratchpad.

Closing the editor does not resolve a Transaction. The Scratchpads tree keeps its
status and ordered Statements visible, with explicit **Commit** and **Rollback**
actions. A failed Transaction can only be rolled back. Changing the Association or
Mode, deleting or renaming the Scratchpad, and disconnecting its Connexion require
the active Transaction to be resolved or the operation to be cancelled.

On extension deactivation or VS Code shutdown, PostgreSQL Workbench makes a
best-effort rollback of every active Transaction and closes its dedicated session.
Shutdown never commits implicitly. In Mode MANUAL, transaction-control Statements
such as `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, and `SET TRANSACTION` are rejected
because Transaction control belongs to the Scratchpad.

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
