---
title: Run, debug, and deploy SQL
description: Understand which PostgreSQL actions are available in each Workbench editing context.
eyebrow: Execution contract
---

# Run, debug, and deploy SQL

PostgreSQL Workbench separates three intentions that must never be confused:

- **Run** executes SQL against PostgreSQL.
- **Debug** executes one reproducible SQL entry point while attaching the
  PL/pgSQL debugger to one indexed routine.
- **Deploy** replaces one explicitly bound PostgreSQL object after validating
  its identity. It is not a synonym for Run or Save.

The available action depends on both the editor context and the SQL shape that
the shared PostgreSQL parser can prove. An action that cannot be proved safe is
not guessed: it is hidden or rejected with the missing precondition.

## Ubiquitous language and context ownership

| Term | Meaning |
| --- | --- |
| **DatabaseContext** | The active saved Connexion followed by Sources, the Cockpit, search, and ordinary authoring. |
| **Scratchpad Association** | The saved Connexion persisted by a Scratchpad. Its cells, results, completion, Run, and Debug use this Association exclusively. |
| **Document Association** | The saved Connexion selected for a free `.sql` or `.pgsql` document. Run and Debug use the same Association instead of remembering different connections per call. |
| **Object Binding** | The immutable server, database, object kind, schema, name, and signature carried by an indexed managed source. It never follows the active DatabaseContext. |
| **Working copy** | Edited text derived from a managed deployed source. Saving the working copy does not by itself change PostgreSQL. |
| **Execution intent** | The cell or Statement action: **Run** or **Debug**. It is independent from the Scratchpad Transaction Mode. |

## Action matrix by editor context

| Editor context | Context used | Run | Debug | Deploy or synchronize |
| --- | --- | --- | --- | --- |
| **Workbench Scratchpad** | Its persisted Scratchpad Association | Runs the cell's valid SQL plan. AUTO uses a dedicated session; MANUAL uses the Scratchpad Transaction. | Available for an analyzed, replayable PL/pgSQL entry point. Debug uses the same Association. | Never implicit. Running DDL is an explicit SQL execution, not managed synchronization. |
| **Free `.sql` or `.pgsql` file** | One Document Association | Runs the selected or analyzed Statement on that Association. | Available for the same analyzed entry points and the same Association. | Never synchronized. A `CREATE OR REPLACE` or any other DDL remains an explicit SQL execution reviewed and started by the user. |
| **Managed routine source** | Its Object Binding | The definition itself is not exposed as Run because that would disguise deployment as execution. | Debugs the deployed routine represented by the Object Binding. | An explicit Deploy is allowed only for the safe routine replacement contract below. Save stores a working copy; it is not Deploy. |
| **Managed trigger source** | Its Object Binding | A generated DML harness can be run from a Scratchpad. The trigger definition itself is not run. | A generated DML harness can debug its indexed PL/pgSQL trigger function when the trigger is unambiguous. | Read-only for now. Trigger replacement is not presented as synchronized until its full identity and replacement sequence are validated atomically. |
| **Managed table, view, schema, or other indexed definition** | Its Object Binding | Browse, compose, or copy SQL; the indexed definition is not executed as a generic Run action. | Not applicable unless an analyzed DML harness identifies one PL/pgSQL trigger entry point. | Read-only. PostgreSQL Workbench does not synchronize tables, views, schemas, DML, or arbitrary DDL. |

## Action matrix by analyzed SQL shape

The following table applies inside a Scratchpad or free SQL document. The
context column above still decides which Connexion and index are authoritative.

| Analyzed SQL shape | Run | Debug | Required debug proof |
| --- | --- | --- | --- |
| Ordinary `SELECT`, DML, or utility Statement | Yes | No | No PL/pgSQL entry point is identified. |
| `SELECT * FROM schema.function(...)` | Yes | Yes | Exactly one replayable, indexed PL/pgSQL function is resolved. |
| `SELECT schema.function(...)` | Yes | Yes | Same proof as the set-returning form. The word `SELECT` does not make a routine call non-debuggable. |
| `CALL schema.procedure(...)` | Yes | Yes | Exactly one replayable, indexed PL/pgSQL procedure is resolved. |
| Generated `DO` block containing one procedure `CALL` | Yes | Yes when the inner call and its target are resolved uniquely | The debugger executes the block but stops in the bound procedure; it does not pretend the anonymous block is a deployed routine. |
| Workbench-generated DML harness for one indexed trigger | Yes | Yes | The harness carries the exact indexed PL/pgSQL trigger-function identity selected during generation. |
| Handwritten DML, or DML that may fire several eligible triggers | Yes | Not until one entry trigger is selected explicitly | Workbench does not guess which of several PostgreSQL triggers should own the debug session. |
| `CREATE OR REPLACE FUNCTION` or `PROCEDURE` | Yes, as explicit DDL | Not as the edited definition | Debug targets the deployed counterpart only after identity and source state are clear. Use Compare or Deploy first. |
| Multiple Statements or several routine entry points | Yes as a Run plan where the surface supports it | Choice required, otherwise unavailable | Debug always launches one selected Statement and one entry routine. |
| Parser error, truncated analysis, stale index, unresolved overload, external parameter, or row-dependent call | PostgreSQL execution may still be possible where Run explicitly allows it | No | Workbench must not invent a debugger target from incomplete evidence. |

## Debug eligibility decision

Debug is offered only when all of the following are true:

1. The complete target Statement has a usable, non-truncated syntax tree.
2. Workbench identifies one top-level entry shape: a direct `CALL`, a function
   application in the top-level `SELECT` target or `FROM`, one supported `CALL`
   inside a generated `DO` harness, or the exact trigger function carried by a
   Workbench-generated DML harness.
3. The target is schema-qualified, or PostgreSQL Workbench can resolve exactly
   one indexed overload without relying on an implicit `search_path` guess.
4. The resolved object is a PL/pgSQL function, procedure, or trigger function
   in the authoritative context's fresh index.
5. The invocation is reproducible. A direct call may use literals, casts,
   named arguments, and self-contained expressions. A call depending on a row
   value, a client bind parameter, or an unresolved external variable is not
   replayed as a separate debugger launch.
6. The saved Connexion supports `pldbgapi`, and no other Workbench debug session
   is active.
7. A Scratchpad in Mode MANUAL has no Debug action. The debugger owns separate
   PostgreSQL sessions and cannot observe or safely join that Scratchpad's open
   Transaction. Change to AUTO, Commit, or Rollback first.

Debug executes the SQL entry statement. For a function call in a `SELECT`, the
query result remains a normal bounded Workbench result. For a procedure, the
`CALL` result and PostgreSQL notices remain available. For a trigger, the DML
harness is the target query and the debugger stops in the selected trigger
function.

## Safe routine deployment contract

PostgreSQL Workbench currently deploys only a managed PL/pgSQL function or
procedure replacement. Every condition below is mandatory:

1. The working copy contains exactly one top-level `CREATE OR REPLACE FUNCTION`
   or `CREATE OR REPLACE PROCEDURE` Statement and no unrelated SQL.
2. The syntax tree is complete and valid, and the declared language is
   `plpgsql`.
3. Object kind, schema, routine name, input parameter modes, and canonical input
   types match the managed Object Binding exactly. Overloads are separate
   objects.
4. The deployed definition is still identical to the base definition from
   which the working copy was created. An external replacement creates a
   conflict and must be compared or reopened; Workbench never overwrites it
   silently.
5. The bound Connexion and database still exist, and the indexed revision is
   fresh. The active DatabaseContext is irrelevant.
6. PostgreSQL accepts the replacement. Workbench then refreshes the bound
   database index and clears the saved working copy only after that successful
   deployment.

A changed name, kind, schema, or input signature creates a different PostgreSQL
object. Workbench must not silently deploy it over the binding. The user may
save it to a free SQL file and run that DDL explicitly after reviewing it, but
that explicit execution is not managed synchronization.

`CREATE TABLE`, `ALTER TABLE`, `CREATE VIEW`, schema changes, DML, batches, and
arbitrary DDL are outside managed synchronization. They remain explicit SQL the
user may run in a Scratchpad or free SQL file. This boundary is deliberately
conservative: an indexed definition is not a general database migration tool.

If PostgreSQL accepts the replacement but the subsequent Workbench refresh
fails, the deployment remains successful. Workbench marks the index stale and
asks for a reindex; it never reports that the already-applied replacement was
rejected.

## Visible controls and feedback

- A Scratchpad cell shows its persisted **Run** or **Debug** intent beside its
  Association and Statement timeout. The native cell action executes that
  intent.
- A free SQL document shows one connection control for its Document
  Association. Every non-empty PostgreSQL Statement has a **Run SQL** CodeLens,
  even when semantic analysis cannot prove that it is valid. A second **Debug
  PL/pgSQL** CodeLens appears only for an eligible routine entry point. Both
  actions use the same Association.
- A managed routine source keeps Save separate from Deploy. It offers
  **Deploy** and **Debug deployed routine** only when applicable; a rejected
  deployment leaves the working copy intact.
- An unavailable action explains one concrete cause, such as **Index stale**,
  **Call depends on a row value**, **Several overloads match**, or **Mode MANUAL
  has an open Transaction**.
- User-facing messages stay short. Full URIs, parser diagnostics, and technical
  deployment details belong in the PostgreSQL Workbench output channel.
