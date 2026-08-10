CREATE EXTENSION pgtap;

CREATE OR REPLACE FUNCTION public.coverage_subject(value integer)
RETURNS integer
LANGUAGE plpgsql
AS $function$
DECLARE
  total integer := 0;
BEGIN
  IF value >= 0 THEN
    FOR index IN 1..value LOOP
      total := total + index;
    END LOOP;
  ELSE
    total := value;
  END IF;

  RETURN total;
END;
$function$;

CREATE OR REPLACE FUNCTION public.coverage_subject(value text)
RETURNS text
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN upper(value);
END;
$function$;

CREATE OR REPLACE FUNCTION public.coverage_wrapper(value integer)
RETURNS integer
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN public.coverage_subject(value);
END;
$function$;

CREATE OR REPLACE PROCEDURE public.coverage_transaction_procedure()
LANGUAGE plpgsql
AS $procedure$
BEGIN COMMIT; END;
$procedure$;

CREATE ROLE coverage_reader;
GRANT USAGE ON SCHEMA public TO coverage_reader;
GRANT EXECUTE ON FUNCTION public.coverage_subject(integer) TO coverage_reader;

CREATE SCHEMA public_ut;

CREATE OR REPLACE FUNCTION public_ut.coverage_test_helper(value integer)
RETURNS integer
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN public.coverage_subject(value);
END;
$function$;

CREATE OR REPLACE FUNCTION public_ut.test_coverage_subject()
RETURNS SETOF text
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN NEXT plan(4);
  RETURN NEXT is(public_ut.coverage_test_helper(-1), -1, 'negative values use the alternative branch');
  RETURN NEXT is(public.coverage_subject(0), 0, 'zero skips the loop');
  RETURN NEXT is(public.coverage_subject(3), 6, 'positive values enter the loop');
  RETURN NEXT is(public.coverage_subject('covered'::text), 'COVERED', 'text overload remains callable');
  RETURN QUERY SELECT * FROM finish();
END;
$function$;

CREATE OR REPLACE FUNCTION public_ut.test_coverage_failure()
RETURNS SETOF text
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN NEXT plan(1);
  RETURN NEXT is(public.coverage_subject(3), 999, 'intentional discovery failure');
  RETURN QUERY SELECT * FROM finish();
END;
$function$;

CREATE OR REPLACE FUNCTION public_ut.test_coverage_error()
RETURNS SETOF text
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'intentional pgTAP execution error';
END;
$function$;

CREATE OR REPLACE FUNCTION public_ut.test_coverage_mapped_error()
RETURNS SETOF text
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM public.coverage_subject(1);
  RAISE EXCEPTION 'intentional mapped pgTAP execution error';
END;
$function$;

CREATE OR REPLACE FUNCTION public_ut.test_coverage_slow()
RETURNS SETOF text
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM public.coverage_subject(1);
  PERFORM pg_sleep(10);
  RETURN NEXT plan(1);
  RETURN NEXT pass('slow test completed');
  RETURN QUERY SELECT * FROM finish();
END;
$function$;

CREATE OR REPLACE FUNCTION public_ut.test_coverage_invalid_tap()
RETURNS SETOF text
LANGUAGE sql
AS $function$
  SELECT 'this is not TAP'::text
$function$;

CREATE OR REPLACE FUNCTION public_ut.test_requires_argument(value integer)
RETURNS SETOF text
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN NEXT pass('argument supplied');
END;
$function$;

CREATE SCHEMA public_it;
CREATE SCHEMA empty_ut;

CREATE OR REPLACE FUNCTION public_it.test_coverage_integration()
RETURNS SETOF text
LANGUAGE sql
AS $function$
  SELECT plan(1)
  UNION ALL
  SELECT is(public.coverage_wrapper(3), 6, 'wrapper integration');
$function$;

-- A non-conventional schema and function name used to verify configurable
-- schema.function discovery patterns.
CREATE SCHEMA quality;

CREATE OR REPLACE FUNCTION quality.coverage_test_helper(value integer)
RETURNS integer
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN public.coverage_subject(value);
END;
$function$;

CREATE OR REPLACE FUNCTION quality.check_coverage_subject()
RETURNS SETOF text
LANGUAGE sql
AS $function$
  SELECT plan(1)
  UNION ALL
  SELECT is(quality.coverage_test_helper(3), 6, 'custom discovery pattern');
$function$;
