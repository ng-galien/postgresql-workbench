-- Recursive debugger example shared by the demo and the E2E fixtures.
CREATE SCHEMA IF NOT EXISTS playground;

-- STRICT keeps generated NULL argument placeholders from entering an
-- unbounded recursive branch.
CREATE OR REPLACE FUNCTION playground.fib(n int)
RETURNS bigint AS $$
DECLARE
  result bigint;
BEGIN
  IF n < 2 THEN
    RETURN n;
  END IF;
  result := playground.fib(n - 1) + playground.fib(n - 2);
  RETURN result;
END;
$$ LANGUAGE plpgsql STRICT;
