-- Simple function with scalar variables
CREATE OR REPLACE FUNCTION test_simple(a int, b text)
RETURNS text AS $$
DECLARE
  result text;
  counter int := 0;
BEGIN
  counter := a + 1;
  result := b || ' - ' || counter::text;
  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Function with record type
CREATE TYPE test_record AS (
  id int,
  name text,
  active boolean
);

CREATE OR REPLACE FUNCTION test_record_var()
RETURNS test_record AS $$
DECLARE
  rec test_record;
BEGIN
  rec.id := 42;
  rec.name := 'test';
  rec.active := true;
  RETURN rec;
END;
$$ LANGUAGE plpgsql;

-- Two distinct named composites used to verify compact expandable values.
CREATE TYPE test_product AS (
  id int,
  name text,
  stock int
);

CREATE TYPE test_customer AS (
  id int,
  name text,
  loyalty_points int
);

CREATE OR REPLACE FUNCTION test_composite_records()
RETURNS int AS $$
DECLARE
  prod test_product;
  cust test_customer;
BEGIN
  prod := ROW(1, 'Saumon fumé', 12)::test_product;
  cust := ROW(1, 'Alice', 120)::test_customer;
  RETURN prod.id + cust.id;
END;
$$ LANGUAGE plpgsql;

-- Function with array
CREATE OR REPLACE FUNCTION test_array_var()
RETURNS int[] AS $$
DECLARE
  arr int[] := ARRAY[1, 2, 3];
BEGIN
  arr := array_append(arr, 4);
  RETURN arr;
END;
$$ LANGUAGE plpgsql;

-- Function calling another function (for step into)
CREATE OR REPLACE FUNCTION test_inner(x int)
RETURNS int AS $$
BEGIN
  RETURN x * 2;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION test_step_into(val int)
RETURNS int AS $$
DECLARE
  result int;
BEGIN
  result := test_inner(val);
  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Function with sequential increments (for breakpoint line verification)
CREATE OR REPLACE FUNCTION test_increments()
RETURNS int AS $$
DECLARE
  i int := 0;
BEGIN
  i := i + 1;
  i := i + 1;
  i := i + 1;
  i := i + 1;
  i := i + 1;
  RETURN i;
END;
$$ LANGUAGE plpgsql;

-- Function with JSONB variable
CREATE OR REPLACE FUNCTION test_json_var()
RETURNS jsonb AS $$
DECLARE
  j jsonb;
BEGIN
  j := '{"name": "alice", "age": 30}'::jsonb;
  j := j || '{"active": true}'::jsonb;
  RETURN j;
END;
$$ LANGUAGE plpgsql;

-- Function with array of records
CREATE OR REPLACE FUNCTION test_record_array()
RETURNS test_record[] AS $$
DECLARE
  arr test_record[];
  r test_record;
BEGIN
  r.id := 1;
  r.name := 'first';
  r.active := true;
  arr := ARRAY[r];
  r.id := 2;
  r.name := 'second';
  r.active := false;
  arr := array_append(arr, r);
  RETURN arr;
END;
$$ LANGUAGE plpgsql;

-- Anonymous record populated by SELECT INTO. Explicit casts let the DAP source
-- analysis preserve PostgreSQL field types that JSON alone would erase.
CREATE OR REPLACE FUNCTION test_anonymous_record()
RETURNS jsonb AS $$
DECLARE
  rec record;
  marker int := 0;
BEGIN
  SELECT 42::int AS id,
         15.00::numeric AS amount,
         DATE '2026-01-02' AS created_at,
         NULL::text AS note,
         ARRAY[1, 2]::int[] AS tags,
         jsonb_build_object('active', true)::jsonb AS meta
    INTO rec;
  marker := rec.id;
  RETURN to_jsonb(rec);
END;
$$ LANGUAGE plpgsql;

-- Anonymous loop record: the row shape exists only for the current iteration.
CREATE OR REPLACE FUNCTION test_anonymous_loop_record()
RETURNS int AS $$
DECLARE
  rec record;
  result int := 0;
BEGIN
  FOR rec IN
    SELECT value::int AS id, (value * 1.50)::numeric AS amount
      FROM generate_series(1, 2) AS value
  LOOP
    result := rec.id;
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Procedure with INOUT parameter (for CALL debugging)
CREATE OR REPLACE PROCEDURE test_proc(INOUT total int)
AS $$
DECLARE
  bonus int := 10;
BEGIN
  total := total + bonus;
  total := total * 2;
END;
$$ LANGUAGE plpgsql;

-- Function with loop
CREATE OR REPLACE FUNCTION test_loop(n int)
RETURNS int AS $$
DECLARE
  total int := 0;
  i int;
BEGIN
  FOR i IN 1..n LOOP
    total := total + i;
  END LOOP;
  RETURN total;
END;
$$ LANGUAGE plpgsql;

-- Recursive entry used to prove that the attach breakpoint is one-shot.
CREATE OR REPLACE FUNCTION test_recursive_entry(n int)
RETURNS int AS $$
BEGIN
  IF n <= 1 THEN
    RETURN n;
  END IF;
  RETURN test_recursive_entry(n - 1) + test_recursive_entry(n - 2);
END;
$$ LANGUAGE plpgsql;

-- Set-returning function used to verify bounded result streaming.
CREATE OR REPLACE FUNCTION test_many_rows(n int)
RETURNS TABLE(id int, payload jsonb) AS $$
BEGIN
  FOR id IN 1..n LOOP
    payload := jsonb_build_object('id', id, 'label', repeat('row-' || id::text, 4));
    RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- SETOF a named composite row. This differs from RETURNS TABLE: PostgreSQL
-- exposes the declared composite type as the function's return contract.
CREATE OR REPLACE FUNCTION test_setof_record_rows()
RETURNS SETOF test_record AS $$
BEGIN
  RETURN NEXT ROW(1, 'first', true)::test_record;
  RETURN NEXT ROW(2, '', false)::test_record;
  RETURN NEXT ROW(3, NULL, NULL)::test_record;
END;
$$ LANGUAGE plpgsql;

-- SETOF an anonymous record. The callsite supplies the row descriptor because
-- the function itself intentionally exposes only PostgreSQL's record type.
CREATE OR REPLACE FUNCTION test_setof_anonymous_rows()
RETURNS SETOF record AS $$
BEGIN
  RETURN NEXT ROW(10, 'alpha'::text, 1.50::numeric, NULL::text);
  RETURN NEXT ROW(11, ''::text, 2.25::numeric, 'note'::text);
END;
$$ LANGUAGE plpgsql;
