-- Classic algorithms: recursion, loops, branches — ideal for step into / step over.
CREATE SCHEMA IF NOT EXISTS playground;
-- Recursion: watch the call stack grow with Step Into.
CREATE OR REPLACE FUNCTION playground.fib(n int)
RETURNS bigint AS $$
BEGIN
  IF n < 2 THEN
    RETURN n;
  END IF;
  RETURN playground.fib(n - 1) + playground.fib(n - 2);
END;
$$ LANGUAGE plpgsql;

-- Collatz conjecture: WHILE loop with IF/ELSE, three variables to watch.
CREATE OR REPLACE FUNCTION playground.collatz(start_n bigint)
RETURNS int AS $$
DECLARE
  n bigint := start_n;
  steps int := 0;
  peak bigint := start_n;
BEGIN
  WHILE n <> 1 LOOP
    IF n % 2 = 0 THEN
      n := n / 2;
    ELSE
      n := 3 * n + 1;
    END IF;
    peak := greatest(peak, n);
    steps := steps + 1;
  END LOOP;
  RAISE NOTICE 'collatz(%) = % steps, peak %', start_n, steps, peak;
  RETURN steps;
END;
$$ LANGUAGE plpgsql;

-- FizzBuzz: FOR loop + CASE, text accumulation.
CREATE OR REPLACE FUNCTION playground.fizzbuzz(up_to int)
RETURNS text[] AS $$
DECLARE
  result text[] := '{}';
  word text;
BEGIN
  FOR i IN 1..up_to LOOP
    word := CASE
      WHEN i % 15 = 0 THEN 'FizzBuzz'
      WHEN i % 3 = 0 THEN 'Fizz'
      WHEN i % 5 = 0 THEN 'Buzz'
      ELSE i::text
    END;
    result := array_append(result, word);
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Integer array: watch the result grow after every loop iteration.
CREATE OR REPLACE FUNCTION playground.square_numbers(up_to int)
RETURNS int[] AS $$
DECLARE
  result int[] := ARRAY[]::int[];
BEGIN
  IF up_to < 1 THEN
    RETURN result;
  END IF;

  FOR value IN 1..up_to LOOP
    result := array_append(result, value * value);
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Two-dimensional array: inspect both the current row and the completed matrix.
CREATE OR REPLACE FUNCTION playground.multiplication_table(row_count int, column_count int)
RETURNS int[][] AS $$
DECLARE
  result int[][];
  current_row int[];
BEGIN
  IF row_count < 1 OR column_count < 1 THEN
    RETURN ARRAY[]::int[];
  END IF;

  FOR row_index IN 1..row_count LOOP
    current_row := ARRAY[]::int[];
    FOR column_index IN 1..column_count LOOP
      current_row := array_append(current_row, row_index * column_index);
    END LOOP;
    result := array_cat(result, ARRAY[current_row]);
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Scalar row set: RETURN NEXT emits one integer result row per iteration.
CREATE OR REPLACE FUNCTION playground.square_rows(up_to int)
RETURNS SETOF int AS $$
BEGIN
  IF up_to < 1 THEN
    RETURN;
  END IF;

  FOR value IN 1..up_to LOOP
    RETURN NEXT value * value;
  END LOOP;
  RETURN;
END;
$$ LANGUAGE plpgsql;

-- Named row set: output parameters form a composite row for every RETURN NEXT.
CREATE OR REPLACE FUNCTION playground.fizzbuzz_rows(up_to int)
RETURNS TABLE(item_number int, label text) AS $$
DECLARE
  current_number int;
BEGIN
  IF up_to < 1 THEN
    RETURN;
  END IF;

  FOR current_number IN 1..up_to LOOP
    item_number := current_number;
    label := CASE
      WHEN current_number % 15 = 0 THEN 'FizzBuzz'
      WHEN current_number % 3 = 0 THEN 'Fizz'
      WHEN current_number % 5 = 0 THEN 'Buzz'
      ELSE current_number::text
    END;
    RETURN NEXT;
  END LOOP;
  RETURN;
END;
$$ LANGUAGE plpgsql;

-- Roman numerals: parallel arrays + WHILE loop.
CREATE OR REPLACE FUNCTION playground.to_roman(n int)
RETURNS text AS $$
DECLARE
  values int[] := ARRAY[1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  symbols text[] := ARRAY['M', 'CM', 'D', 'CD', 'C', 'XC', 'L', 'XL', 'X', 'IX', 'V', 'IV', 'I'];
  remaining int := n;
  roman text := '';
BEGIN
  IF n < 1 OR n > 3999 THEN
    RAISE EXCEPTION 'to_roman only supports 1..3999, got %', n;
  END IF;
  FOR i IN 1..array_length(values, 1) LOOP
    WHILE remaining >= values[i] LOOP
      roman := roman || symbols[i];
      remaining := remaining - values[i];
    END LOOP;
  END LOOP;
  RETURN roman;
END;
$$ LANGUAGE plpgsql;

-- ASCII Mandelbrot: nested loops, numeric math, one breakpoint deep inside
-- the inner loop shows off conditional breakpoints nicely.
CREATE OR REPLACE FUNCTION playground.mandelbrot(width int DEFAULT 60, height int DEFAULT 24, max_iter int DEFAULT 30)
RETURNS text AS $$
DECLARE
  chars text := ' .:-=+*#%@';
  art text := '';
  cx numeric; cy numeric;
  zx numeric; zy numeric; tmp numeric;
  iter int;
BEGIN
  FOR py IN 0..height - 1 LOOP
    FOR px IN 0..width - 1 LOOP
      cx := (px::numeric / width) * 3.0 - 2.1;
      cy := (py::numeric / height) * 2.4 - 1.2;
      zx := 0; zy := 0; iter := 0;
      WHILE zx * zx + zy * zy < 4 AND iter < max_iter LOOP
        tmp := zx * zx - zy * zy + cx;
        zy := 2 * zx * zy + cy;
        zx := tmp;
        iter := iter + 1;
      END LOOP;
      art := art || substr(chars, 1 + (iter * (length(chars) - 1) / max_iter), 1);
    END LOOP;
    art := art || E'\n';
  END LOOP;
  RETURN art;
END;
$$ LANGUAGE plpgsql;
