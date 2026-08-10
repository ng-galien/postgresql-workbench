-- Test functions for PostgreSQL Workbench

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

-- ============================================================
-- Call sites — CodeLens "▶ Debug call" should appear on each
-- ============================================================

-- Simple calls
SELECT test_simple(3, 'hello');
SELECT test_loop(5);
SELECT test_step_into(7);

-- Multiline call with args on separate lines
SELECT test_simple(
  100,
  'multiline arg'
);

-- Call with blank lines and comments around it

-- This tests edge spacing
SELECT test_loop(
  10
);

-- Schema-qualified call (public schema)
SELECT public.test_inner(42);

-- Call with no args (test_record_var if it exists)
-- SELECT test_record_var();

-- Multiple calls on consecutive lines, no blank lines
SELECT test_inner(1);
SELECT test_inner(2);
SELECT test_inner(3);

-- Call after many blank lines



SELECT test_simple(0, 'after blanks');

-- Call with a block comment before it
/* This is a block comment
   spanning multiple lines */
SELECT test_loop(20);
