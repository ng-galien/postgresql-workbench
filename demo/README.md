# Demo playground

A PostgreSQL container with `pldbgapi` pre-installed and a set of PL/pgSQL
functions designed to show off the debugger: recursion, loops, records,
exception handling, JSONB, pgTAP tests, and native PL/pgSQL coverage. The
`shop` schema also contains a connected commerce model with 28 tables, seeded
data, three views, and simple routines for evaluating the Workbench tree and
dependency graph on something larger than a toy schema.

The playground uses the same
[`galien0xffffff/postgres-debugger:17`](https://hub.docker.com/r/galien0xffffff/postgres-debugger)
image offered by the VS Code command **PostgreSQL Workbench: Start Local Debug Database
(Docker)**. The canonical local [Dockerfile](../docker/postgres/Dockerfile) adds the PostgreSQL 17
pgTAP package once and is shared by the demo, integration tests, and internal
index benchmark. Published debugger image tags cover PostgreSQL 13–18 on amd64
and arm64.

## Start

```bash
docker compose -f docker/demo/compose.yml up -d --wait
```

Connection: `postgresql://postgres:postgres@localhost:5434/demo`
(port 5434 — does not conflict with e2e tests on 5433 or a local PostgreSQL on 5432).

## Use

1. Install the extension (`vscode-extension/postgresql-workbench-*.vsix`).
2. In the PL/pgSQL sidebar, **Add Connection** and paste the connection string above.
3. Open [debug-me.sql](debug-me.sql) and click a **Debug** CodeLens, or browse
   the `playground` / `shop` schemas in the sidebar and debug from the tree.

## Run pgTAP tests and coverage

The database initializes seven passing pgTAP test functions from
[`init/04-pgtap.sql`](init/04-pgtap.sql):

- their qualified names match the default `*_ut.test_*` and `*_it.test_*`
  discovery patterns;
- the order workflow creates and removes its own fixtures;
- every source routine call is schema-qualified so the extension can map tests
  to covered PL/pgSQL routines through the pgTAP function AST.

Open VS Code's **Testing** view and expand the `localhost:5434/demo`
connection. Use **Run Tests** for normal pgTAP execution or **Run Tests with
Coverage** to publish statement and branch coverage in VS Code's native
coverage view and editor gutter.

The coverage runner always rolls its instrumentation and test data back.
Normal pgTAP runs are not transactional, so the order workflow test performs
its own fixture cleanup.

To inspect one suite directly:

```bash
docker compose -f docker/demo/compose.yml exec postgres \
  psql -U postgres -d demo \
  -c "SELECT * FROM playground_ut.test_fibonacci();"
```

## What to try

| Function | Shows off |
|---|---|
| `playground.fib(8)` | Step Into on recursion, stack frames |
| `playground.collatz(27)` | WHILE + IF/ELSE, variables changing each step |
| `playground.fizzbuzz(20)` | FOR + CASE, array accumulation |
| `playground.square_numbers(8)` | scalar array built one item at a time |
| `playground.multiplication_table(4, 5)` | nested loops and a two-dimensional array |
| `SELECT * FROM playground.square_rows(8)` | scalar `SETOF` with `RETURN NEXT` |
| `SELECT * FROM playground.fizzbuzz_rows(20)` | named rows through `RETURNS TABLE` |
| `playground.to_roman(1987)` | parallel arrays, nested WHILE |
| `playground.mandelbrot()` | nested loops — try a conditional breakpoint |
| `shop.place_order(1, 1, 2)` | record variables from real tables, JSON display |
| `SELECT * FROM shop.stock_movement` | rows written by `product_stock_audit → audit_product_stock()` |
| `shop.restock_report()` | FOR rec IN SELECT, JSONB accumulation |
| `shop.low_stock_products(10)` | array of composite table rows |
| `SELECT * FROM shop.low_stock_rows(10)` | composite `SETOF shop.product` rows |
| `CALL shop.try_order(2, 3, 1)` | EXCEPTION block (product 3 is out of stock) |
| `SELECT * FROM shop.product_availability` | products, brands, warehouses and inventory |
| `SELECT * FROM shop.order_overview` | customers, orders, lines, payments and shipments |
| `SELECT * FROM shop.support_queue` | customers, orders, assignees and support tickets |
| `shop.available_inventory(1)` | a small SQL routine reading the inventory graph |
| `shop.reprice_order(4)` | a short PL/pgSQL routine updating order lines and totals |
| `CALL shop.move_inventory(1, 2, 3, 1, 5)` | a transactional stock transfer between warehouses |

`RAISE NOTICE` output lands in the Debug Console.

## Stop

```bash
docker compose -f docker/demo/compose.yml down -v
```
