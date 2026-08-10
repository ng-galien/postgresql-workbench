-- Open this file in VS Code with the PostgreSQL Workbench extension connected to
-- postgresql://postgres:postgres@localhost:5434/demo
-- Each statement below gets a "Debug" CodeLens — click it to start a session.

-- Recursion: use Step Into and watch the call stack grow.
SELECT playground.fib(8);

-- WHILE loop with branches: watch n, steps, peak change on each step.
SELECT playground.collatz(27);

-- FOR loop + CASE: watch the result array fill up.
SELECT playground.fizzbuzz(20);

-- Arrays + nested WHILE: try a breakpoint inside the inner loop.
SELECT playground.to_roman(1987);

-- Nested loops + math: set a conditional breakpoint on iter (e.g. iter > 20).
SELECT playground.mandelbrot(40, 16, 25);

-- Records from real tables: inspect prod, cust, line as JSON.
SELECT shop.place_order(1, 1, 2);

-- The stock audit trigger records the product update performed by place_order.
SELECT * FROM shop.stock_movement ORDER BY id DESC LIMIT 5;

-- FOR rec IN SELECT + JSONB accumulation.
SELECT shop.restock_report(10);

-- Error path: product 3 is out of stock — step into the EXCEPTION block.
CALL shop.try_order(2, 3, 1);

-- Happy path through the procedure.
CALL shop.try_order(3, 4, 5);

-- Integer array: watch the result grow one square at a time.
SELECT playground.square_numbers(8);

-- Two-dimensional integer array: inspect current_row and the completed matrix.
SELECT playground.multiplication_table(4, 5);

-- Composite array built from table rows: inspect prod and products.
SELECT shop.low_stock_products(10);

-- SETOF scalar: each RETURN NEXT produces one result row.
SELECT * FROM playground.square_rows(8);

-- RETURNS TABLE: inspect the output variables before every RETURN NEXT.
SELECT * FROM playground.fizzbuzz_rows(20);

-- SETOF composite: every low-stock product is returned as a separate row.
SELECT * FROM shop.low_stock_rows(10);
