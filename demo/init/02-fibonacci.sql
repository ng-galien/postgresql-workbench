-- Recursive debugger example shared by the demo and the E2E fixtures.
CREATE SCHEMA IF NOT EXISTS playground;

-- The explicit NULL guard keeps generated argument placeholders safe without
-- changing the recursive debugger trajectory exposed by pldbgapi.
CREATE OR REPLACE FUNCTION playground.fib(n int)
RETURNS bigint AS $$
DECLARE
  result bigint;
BEGIN
  IF n IS NULL OR n < 2 THEN
    RETURN n;
  END IF;
  result := playground.fib(n - 1) + playground.fib(n - 2);
  RETURN result;
END;
$$ LANGUAGE plpgsql;
