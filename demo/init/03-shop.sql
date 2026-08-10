-- Mini shop: real tables, record variables, FOR..IN SELECT, exception handling.
-- Good for inspecting composite/record variables and JSONB during a session.
CREATE SCHEMA IF NOT EXISTS shop;
CREATE TABLE shop.product (
  id serial PRIMARY KEY,
  name text NOT NULL,
  price numeric(8, 2) NOT NULL,
  stock int NOT NULL DEFAULT 0
);

CREATE TABLE shop.customer (
  id serial PRIMARY KEY,
  name text NOT NULL,
  loyalty_points int NOT NULL DEFAULT 0
);

CREATE TABLE shop.order_line (
  id serial PRIMARY KEY,
  customer_id int NOT NULL REFERENCES shop.customer,
  product_id int NOT NULL REFERENCES shop.product,
  quantity int NOT NULL CHECK (quantity > 0),
  total numeric(10, 2)
);

CREATE TABLE shop.stock_movement (
  id bigserial PRIMARY KEY,
  product_id int NOT NULL REFERENCES shop.product,
  old_stock int NOT NULL,
  new_stock int NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO shop.product (name, price, stock) VALUES
  ('Saumon fumé', 24.90, 12),
  ('Magret séché', 18.50, 8),
  ('Truite fumée', 15.00, 0),
  ('Poivre fumé', 6.40, 42);

INSERT INTO shop.customer (name, loyalty_points) VALUES
  ('Alice', 120),
  ('Bob', 0),
  ('Chloé', 45);

-- Place an order: record variables, IF branches, UPDATE, custom exceptions.
CREATE OR REPLACE FUNCTION shop.place_order(p_customer_id int, p_product_id int, p_quantity int)
RETURNS shop.order_line AS $$
DECLARE
  prod shop.product;
  cust shop.customer;
  line shop.order_line;
  discount numeric := 0;
BEGIN
  SELECT * INTO STRICT prod FROM shop.product WHERE id = p_product_id;
  SELECT * INTO STRICT cust FROM shop.customer WHERE id = p_customer_id;

  IF prod.stock < p_quantity THEN
    RAISE EXCEPTION 'Not enough stock for %: % left, % requested',
      prod.name, prod.stock, p_quantity
      USING ERRCODE = 'check_violation';
  END IF;

  IF cust.loyalty_points >= 100 THEN
    discount := 0.10;
  ELSIF cust.loyalty_points >= 50 THEN
    discount := 0.05;
  END IF;

  INSERT INTO shop.order_line (customer_id, product_id, quantity, total)
  VALUES (p_customer_id, p_product_id, p_quantity,
          round(prod.price * p_quantity * (1 - discount), 2))
  RETURNING * INTO line;

  UPDATE shop.product SET stock = stock - p_quantity WHERE id = p_product_id;
  UPDATE shop.customer
    SET loyalty_points = loyalty_points + floor(line.total)::int
    WHERE id = p_customer_id;

  RAISE NOTICE 'Order #%: % x % for % (discount % %%)',
    line.id, p_quantity, prod.name, line.total, discount * 100;
  RETURN line;
END;
$$ LANGUAGE plpgsql;

-- Stock audit: exercises trigger discovery and trigger-to-function navigation.
CREATE OR REPLACE FUNCTION shop.audit_product_stock()
RETURNS trigger AS $$
BEGIN
  INSERT INTO shop.stock_movement (product_id, old_stock, new_stock)
  VALUES (NEW.id, OLD.stock, NEW.stock);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER product_stock_audit
AFTER UPDATE OF stock ON shop.product
FOR EACH ROW
WHEN (OLD.stock IS DISTINCT FROM NEW.stock)
EXECUTE FUNCTION shop.audit_product_stock();

-- Restock report: FOR rec IN SELECT loop + JSONB accumulation.
CREATE OR REPLACE FUNCTION shop.restock_report(threshold int DEFAULT 10)
RETURNS jsonb AS $$
DECLARE
  rec record;
  report jsonb := '[]'::jsonb;
  to_order int;
BEGIN
  FOR rec IN SELECT * FROM shop.product WHERE stock < threshold ORDER BY stock LOOP
    to_order := threshold - rec.stock;
    report := report || jsonb_build_object(
      'product', rec.name,
      'stock', rec.stock,
      'order_quantity', to_order,
      'cost', round(rec.price * to_order * 0.6, 2)
    );
  END LOOP;
  RETURN report;
END;
$$ LANGUAGE plpgsql;

-- Composite array: inspect each table row and the accumulated product array.
CREATE OR REPLACE FUNCTION shop.low_stock_products(threshold int DEFAULT 10)
RETURNS shop.product[] AS $$
DECLARE
  products shop.product[] := ARRAY[]::shop.product[];
  prod shop.product%ROWTYPE;
BEGIN
  FOR prod IN
    SELECT *
    FROM shop.product
    WHERE stock < threshold
    ORDER BY stock, id
  LOOP
    products := array_append(products, prod);
  END LOOP;
  RETURN products;
END;
$$ LANGUAGE plpgsql;

-- Composite row set: RETURN NEXT emits each shop.product as a separate result row.
CREATE OR REPLACE FUNCTION shop.low_stock_rows(threshold int DEFAULT 10)
RETURNS SETOF shop.product AS $$
DECLARE
  prod shop.product%ROWTYPE;
BEGIN
  FOR prod IN
    SELECT *
    FROM shop.product
    WHERE stock < threshold
    ORDER BY stock, id
  LOOP
    RETURN NEXT prod;
  END LOOP;
  RETURN;
END;
$$ LANGUAGE plpgsql;

-- Procedure with INOUT + EXCEPTION block: step through the error path
-- by ordering the out-of-stock 'Truite fumée' (product 3).
CREATE OR REPLACE PROCEDURE shop.try_order(
  p_customer_id int,
  p_product_id int,
  p_quantity int,
  INOUT status text DEFAULT NULL
) AS $$
DECLARE
  line shop.order_line;
BEGIN
  line := shop.place_order(p_customer_id, p_product_id, p_quantity);
  status := format('OK: order #%s, total %s', line.id, line.total);
EXCEPTION
  WHEN check_violation THEN
    status := 'REFUSED: ' || SQLERRM;
  WHEN no_data_found THEN
    status := 'UNKNOWN customer or product';
END;
$$ LANGUAGE plpgsql;
