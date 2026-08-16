-- pgTAP suites discovered by the VS Code Test Explorer.
--
-- The extension maps <schema>_ut and <schema>_it back to their source schema.
-- Keep source routine calls schema-qualified so AST dependency discovery can
-- associate every test with the PL/pgSQL routines that it covers.
CREATE EXTENSION IF NOT EXISTS pgtap;

CREATE SCHEMA IF NOT EXISTS playground_ut;
CREATE SCHEMA IF NOT EXISTS shop_ut;
CREATE SCHEMA IF NOT EXISTS shop_it;

CREATE OR REPLACE FUNCTION playground_ut.test_fibonacci()
RETURNS SETOF text
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN NEXT plan(5);
  RETURN NEXT is(playground.fib(NULL::int), NULL::bigint, 'fib(NULL) does not enter recursion');
  RETURN NEXT is(playground.fib(0), 0::bigint, 'fib(0) is the first base case');
  RETURN NEXT is(playground.fib(1), 1::bigint, 'fib(1) is the second base case');
  RETURN NEXT is(playground.fib(2), 1::bigint, 'fib(2) enters the recursive branch');
  RETURN NEXT is(playground.fib(8), 21::bigint, 'fib(8) resolves the recursive tree');
  RETURN QUERY SELECT * FROM finish();
END;
$function$;

CREATE OR REPLACE FUNCTION playground_ut.test_sequence_algorithms()
RETURNS SETOF text
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN NEXT plan(5);
  RETURN NEXT is(playground.collatz(1), 0, 'collatz(1) skips the loop');
  RETURN NEXT is(playground.collatz(6), 8, 'collatz(6) exercises odd and even branches');
  RETURN NEXT is(
    playground.fizzbuzz(5),
    ARRAY['1', '2', 'Fizz', '4', 'Buzz']::text[],
    'fizzbuzz labels multiples of three and five'
  );
  RETURN NEXT is(
    playground.square_numbers(0),
    ARRAY[]::integer[],
    'square_numbers returns an empty array below one'
  );
  RETURN NEXT is(
    playground.square_numbers(4),
    ARRAY[1, 4, 9, 16],
    'square_numbers accumulates one value per loop'
  );
  RETURN QUERY SELECT * FROM finish();
END;
$function$;

CREATE OR REPLACE FUNCTION playground_ut.test_set_returning_functions()
RETURNS SETOF text
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN NEXT plan(4);
  RETURN NEXT is(
    ARRAY(SELECT value FROM playground.square_rows(0) AS value),
    ARRAY[]::integer[],
    'square_rows returns no rows below one'
  );
  RETURN NEXT is(
    ARRAY(SELECT value FROM playground.square_rows(4) AS value),
    ARRAY[1, 4, 9, 16],
    'square_rows emits each square in order'
  );
  RETURN NEXT is(
    ARRAY(
      SELECT row_data.label
      FROM playground.fizzbuzz_rows(5) AS row_data
      ORDER BY row_data.item_number
    ),
    ARRAY['1', '2', 'Fizz', '4', 'Buzz']::text[],
    'fizzbuzz_rows returns named composite rows'
  );
  RETURN NEXT is(
    playground.multiplication_table(2, 3),
    ARRAY[[1, 2, 3], [2, 4, 6]],
    'multiplication_table fills both dimensions'
  );
  RETURN QUERY SELECT * FROM finish();
END;
$function$;

CREATE OR REPLACE FUNCTION playground_ut.test_roman_numerals()
RETURNS SETOF text
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN NEXT plan(3);
  RETURN NEXT is(playground.to_roman(1), 'I', 'one uses a single symbol');
  RETURN NEXT is(playground.to_roman(1987), 'MCMLXXXVII', '1987 combines subtractive symbols');
  RETURN NEXT is(playground.to_roman(3999), 'MMMCMXCIX', '3999 is the supported upper bound');
  RETURN QUERY SELECT * FROM finish();
END;
$function$;

CREATE OR REPLACE FUNCTION shop_ut.test_stock_queries()
RETURNS SETOF text
LANGUAGE plpgsql
AS $function$
DECLARE
  report jsonb;
BEGIN
  report := shop.restock_report(10);

  RETURN NEXT plan(5);
  RETURN NEXT is(jsonb_array_length(report), 2, 'two products need restocking');
  RETURN NEXT is(report #>> '{0,product}', 'Truite fumée', 'the empty product is listed first');
  RETURN NEXT is(report #>> '{0,order_quantity}', '10', 'the empty product is replenished to ten');
  RETURN NEXT is(
    cardinality(shop.low_stock_products(10)),
    2,
    'the composite array contains both low-stock products'
  );
  RETURN NEXT is(
    ARRAY(
      SELECT product.name
      FROM shop.low_stock_rows(10) AS product
    ),
    ARRAY['Truite fumée', 'Magret séché']::text[],
    'the composite row set preserves stock ordering'
  );
  RETURN QUERY SELECT * FROM finish();
END;
$function$;

CREATE OR REPLACE FUNCTION shop_ut.test_order_rejection()
RETURNS SETOF text
LANGUAGE plpgsql
AS $function$
DECLARE
  rejection_assertion text;
BEGIN
  RETURN NEXT plan(1);

  BEGIN
    PERFORM shop.place_order(2, 3, 1);
    rejection_assertion := fail('place_order should reject an out-of-stock product');
  EXCEPTION
    WHEN check_violation THEN
      rejection_assertion := pass('place_order rejects an out-of-stock product');
  END;

  RETURN NEXT rejection_assertion;
  RETURN QUERY SELECT * FROM finish();
END;
$function$;

CREATE OR REPLACE FUNCTION shop_it.test_place_order_workflow()
RETURNS SETOF text
LANGUAGE plpgsql
AS $function$
DECLARE
  test_customer_id integer;
  test_product_id integer;
  order_result shop.order_line;
  remaining_stock integer;
  updated_points integer;
  movement_count bigint;
  total_assertion text;
  stock_assertion text;
  points_assertion text;
  movement_assertion text;
BEGIN
  RETURN NEXT plan(4);

  INSERT INTO shop.customer (name, loyalty_points)
  VALUES ('pgTAP customer', 100)
  RETURNING id INTO test_customer_id;

  INSERT INTO shop.product (name, price, stock)
  VALUES ('pgTAP product', 10.00, 3)
  RETURNING id INTO test_product_id;

  BEGIN
    order_result := shop.place_order(test_customer_id, test_product_id, 2);

    SELECT stock
    INTO remaining_stock
    FROM shop.product
    WHERE id = test_product_id;

    SELECT loyalty_points
    INTO updated_points
    FROM shop.customer
    WHERE id = test_customer_id;

    SELECT count(*)
    INTO movement_count
    FROM shop.stock_movement
    WHERE product_id = test_product_id;

    total_assertion := is(order_result.total, 18.00::numeric, 'the loyalty discount is applied');
    stock_assertion := is(remaining_stock, 1, 'the ordered quantity is removed from stock');
    points_assertion := is(updated_points, 118, 'the order total is converted to loyalty points');
    movement_assertion := is(movement_count, 1::bigint, 'the stock trigger records the movement');
  EXCEPTION
    WHEN OTHERS THEN
      DELETE FROM shop.order_line WHERE customer_id = test_customer_id;
      DELETE FROM shop.stock_movement WHERE product_id = test_product_id;
      DELETE FROM shop.product WHERE id = test_product_id;
      DELETE FROM shop.customer WHERE id = test_customer_id;
      RAISE;
  END;

  DELETE FROM shop.order_line WHERE customer_id = test_customer_id;
  DELETE FROM shop.stock_movement WHERE product_id = test_product_id;
  DELETE FROM shop.product WHERE id = test_product_id;
  DELETE FROM shop.customer WHERE id = test_customer_id;

  RETURN NEXT total_assertion;
  RETURN NEXT stock_assertion;
  RETURN NEXT points_assertion;
  RETURN NEXT movement_assertion;
  RETURN QUERY SELECT * FROM finish();
END;
$function$;
