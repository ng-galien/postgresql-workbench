---
title: Documentation
description: Set up PostgreSQL Workbench and use its VS Code guides for schemas, SQL, pgTAP coverage, and PL/pgSQL debugging.
eyebrow: Documentation
---

# PostgreSQL Workbench documentation

PostgreSQL Workbench documentation covers the complete PostgreSQL development
workflow in VS Code: schema navigation, SQL Scratchpads, pgTAP coverage,
PL/pgSQL debugging, and the standalone DAP server.

## Start with a development database

1. Run **PostgreSQL Workbench: Add Server**. Several Connexions can stay open
   at once; each one keeps its own index, Cockpit scope, and Scratchpads.
2. Expand the Connexion, then its database: **Schemas** indexes PostgreSQL
   structure automatically on connect. Run **Reindex Database** on that
   Connexion whenever you need a fresh snapshot.

For a disposable local environment, run **PL/pgSQL: Start Local Debug Database
(Docker)**. PostgreSQL 17 and `127.0.0.1:5432` are the defaults; database, user,
and password are all `postgres`.

> Use those fixed credentials only for a local container. Never expose it on
> `0.0.0.0` or a remote host.

## Choose a guide

- [Workbench Cockpit](cockpit.md) — index structure, navigate relations, and
  understand every control.
- [SQL scratchpads](notebooks.md) — bind notebooks, execute SQL, and work safely
  with results.
- [Data View](data-view.md) — open tables, views, and results in an editable
  grid, compose the query, and write rows back.
- [SQL authoring](sql-authoring.md) — format, complete, and compose PostgreSQL
  SQL from one indexed context.
- [Run, debug, and deploy SQL](execution-debugging-and-deployment.md) — understand
  the action matrix for Scratchpads, free SQL files, and managed PostgreSQL sources.
- [pgTAP and coverage](testing-coverage.md) — discover tests, calculate coverage,
  and understand the limits.
- [PL/pgSQL debugger](debugger.md) — prepare PostgreSQL, launch sessions, step,
  and inspect values.
- [Standalone DAP server](dap.md) — integrate the debugger engine with another
  editor or DAP client.
- [Commands and settings](reference.md) — browse the complete generated reference.
- [Measured performance](performance.md) — review reproducible indexing measurements
  on synthetic ERP-scale PostgreSQL catalogs.
