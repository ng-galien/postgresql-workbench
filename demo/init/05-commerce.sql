-- A connected commerce model for evaluating the Workbench on a realistic SQL graph.
-- It deliberately stays approachable: conventional tables, foreign keys, views,
-- and a few small routines that connect business operations to stored data.

CREATE TABLE shop.organization (
  id bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  slug text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shop.address (
  id bigserial PRIMARY KEY,
  label text,
  line1 text NOT NULL,
  line2 text,
  postal_code text NOT NULL,
  city text NOT NULL,
  country_code char(2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shop.app_user (
  id bigserial PRIMARY KEY,
  organization_id bigint NOT NULL REFERENCES shop.organization,
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'operations', 'support', 'analyst')),
  active boolean NOT NULL DEFAULT true,
  -- An identifier that is not a number and cannot be typed from memory.
  external_id uuid NOT NULL DEFAULT gen_random_uuid(),
  -- Where they were, and when — an address, and a moment with no zone to anchor it.
  last_login_ip inet,
  last_seen_at timestamp,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shop.user_profile (
  user_id bigint PRIMARY KEY REFERENCES shop.app_user ON DELETE CASCADE,
  preferred_address_id bigint REFERENCES shop.address,
  locale text NOT NULL DEFAULT 'fr-FR',
  timezone text NOT NULL DEFAULT 'Europe/Paris',
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE shop.customer_address (
  id bigserial PRIMARY KEY,
  customer_id int NOT NULL REFERENCES shop.customer ON DELETE CASCADE,
  address_id bigint NOT NULL REFERENCES shop.address ON DELETE CASCADE,
  address_kind text NOT NULL CHECK (address_kind IN ('billing', 'shipping')),
  is_default boolean NOT NULL DEFAULT false,
  UNIQUE (customer_id, address_id, address_kind)
);

CREATE TABLE shop.category (
  id bigserial PRIMARY KEY,
  parent_id bigint REFERENCES shop.category,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  sort_order int NOT NULL DEFAULT 0
);

CREATE TABLE shop.brand (
  id bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  website text,
  country_code char(2)
);

ALTER TABLE shop.product
  ADD COLUMN sku text,
  ADD COLUMN brand_id bigint REFERENCES shop.brand,
  ADD COLUMN description text,
  ADD COLUMN active boolean NOT NULL DEFAULT true,
  -- A document per product: what it is made of, where it comes from, how it is cured. The shape
  -- of thing nobody wants to read — or edit — as one long line.
  ADD COLUMN attributes jsonb,
  -- The same shape held as PostgreSQL received it. `json` keeps whitespace, key order and
  -- duplicate keys where `jsonb` normalises all three away; a grid showing them identically hides
  -- the one difference between the two types.
  ADD COLUMN supplier_payload json,
  -- A list in one cell.
  ADD COLUMN tags text[],
  -- Somewhere to go.
  ADD COLUMN datasheet_url text,
  -- Bytes, which a grid can say the size of and nothing else.
  ADD COLUMN thumbnail bytea,
  ADD CONSTRAINT product_sku_key UNIQUE (sku);

ALTER TABLE shop.customer
  ADD COLUMN email text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT customer_email_key UNIQUE (email);

CREATE TABLE shop.product_category (
  product_id int NOT NULL REFERENCES shop.product ON DELETE CASCADE,
  category_id bigint NOT NULL REFERENCES shop.category ON DELETE CASCADE,
  featured boolean NOT NULL DEFAULT false,
  PRIMARY KEY (product_id, category_id)
);

CREATE TABLE shop.warehouse (
  id bigserial PRIMARY KEY,
  organization_id bigint NOT NULL REFERENCES shop.organization,
  address_id bigint NOT NULL REFERENCES shop.address,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  -- Times of day with no date to put them on.
  opens_at time,
  closes_at time,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE shop.inventory (
  id bigserial PRIMARY KEY,
  product_id int NOT NULL REFERENCES shop.product,
  warehouse_id bigint NOT NULL REFERENCES shop.warehouse,
  quantity int NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  reserved_quantity int NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
  reorder_level int NOT NULL DEFAULT 5 CHECK (reorder_level >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, warehouse_id),
  CHECK (reserved_quantity <= quantity)
);

CREATE TABLE shop.inventory_movement (
  id bigserial PRIMARY KEY,
  inventory_id bigint NOT NULL REFERENCES shop.inventory,
  performed_by bigint REFERENCES shop.app_user,
  movement_type text NOT NULL
    CHECK (movement_type IN ('receipt', 'sale', 'transfer_in', 'transfer_out', 'adjustment')),
  quantity_delta int NOT NULL CHECK (quantity_delta <> 0),
  reason text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shop.supplier (
  id bigserial PRIMARY KEY,
  organization_id bigint REFERENCES shop.organization,
  address_id bigint REFERENCES shop.address,
  name text NOT NULL UNIQUE,
  email text,
  lead_time_days int NOT NULL DEFAULT 7 CHECK (lead_time_days >= 0),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE shop.supplier_product (
  supplier_id bigint NOT NULL REFERENCES shop.supplier ON DELETE CASCADE,
  product_id int NOT NULL REFERENCES shop.product ON DELETE CASCADE,
  supplier_sku text NOT NULL,
  unit_cost numeric(10, 2) NOT NULL CHECK (unit_cost >= 0),
  minimum_order_quantity int NOT NULL DEFAULT 1 CHECK (minimum_order_quantity > 0),
  PRIMARY KEY (supplier_id, product_id)
);

CREATE TABLE shop.purchase_order (
  id bigserial PRIMARY KEY,
  supplier_id bigint NOT NULL REFERENCES shop.supplier,
  warehouse_id bigint NOT NULL REFERENCES shop.warehouse,
  created_by bigint NOT NULL REFERENCES shop.app_user,
  status text NOT NULL CHECK (status IN ('draft', 'sent', 'partial', 'received', 'cancelled')),
  ordered_at timestamptz,
  expected_at date,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shop.purchase_order_line (
  id bigserial PRIMARY KEY,
  purchase_order_id bigint NOT NULL REFERENCES shop.purchase_order ON DELETE CASCADE,
  product_id int NOT NULL REFERENCES shop.product,
  quantity int NOT NULL CHECK (quantity > 0),
  received_quantity int NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
  unit_cost numeric(10, 2) NOT NULL CHECK (unit_cost >= 0),
  UNIQUE (purchase_order_id, product_id),
  CHECK (received_quantity <= quantity)
);

CREATE TABLE shop.promotion (
  id bigserial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  discount_rate numeric(5, 4) NOT NULL CHECK (discount_rate > 0 AND discount_rate <= 1),
  -- Two bounds in one value, each of which may be open.
  season daterange,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true,
  CHECK (ends_at > starts_at)
);

CREATE TABLE shop.promotion_product (
  promotion_id bigint NOT NULL REFERENCES shop.promotion ON DELETE CASCADE,
  product_id int NOT NULL REFERENCES shop.product ON DELETE CASCADE,
  PRIMARY KEY (promotion_id, product_id)
);

CREATE TABLE shop.sales_order (
  id bigserial PRIMARY KEY,
  customer_id int NOT NULL REFERENCES shop.customer,
  billing_address_id bigint NOT NULL REFERENCES shop.address,
  shipping_address_id bigint NOT NULL REFERENCES shop.address,
  created_by bigint REFERENCES shop.app_user,
  status text NOT NULL CHECK (status IN ('draft', 'confirmed', 'paid', 'shipped', 'completed', 'cancelled')),
  currency char(3) NOT NULL DEFAULT 'EUR',
  subtotal numeric(12, 2) NOT NULL DEFAULT 0,
  discount_total numeric(12, 2) NOT NULL DEFAULT 0,
  tax_total numeric(12, 2) NOT NULL DEFAULT 0,
  grand_total numeric(12, 2) NOT NULL DEFAULT 0,
  placed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shop.sales_order_line (
  id bigserial PRIMARY KEY,
  sales_order_id bigint NOT NULL REFERENCES shop.sales_order ON DELETE CASCADE,
  product_id int NOT NULL REFERENCES shop.product,
  promotion_id bigint REFERENCES shop.promotion,
  quantity int NOT NULL CHECK (quantity > 0),
  unit_price numeric(10, 2) NOT NULL CHECK (unit_price >= 0),
  discount_rate numeric(5, 4) NOT NULL DEFAULT 0 CHECK (discount_rate >= 0 AND discount_rate <= 1),
  line_total numeric(12, 2) NOT NULL CHECK (line_total >= 0)
);

CREATE TABLE shop.payment (
  id bigserial PRIMARY KEY,
  sales_order_id bigint NOT NULL REFERENCES shop.sales_order,
  provider text NOT NULL,
  provider_reference text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('pending', 'authorized', 'captured', 'failed', 'refunded')),
  amount numeric(12, 2) NOT NULL CHECK (amount > 0),
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shop.refund (
  id bigserial PRIMARY KEY,
  payment_id bigint NOT NULL REFERENCES shop.payment,
  requested_by bigint REFERENCES shop.app_user,
  status text NOT NULL CHECK (status IN ('requested', 'approved', 'processed', 'rejected')),
  amount numeric(12, 2) NOT NULL CHECK (amount > 0),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE TABLE shop.shipment (
  id bigserial PRIMARY KEY,
  sales_order_id bigint NOT NULL REFERENCES shop.sales_order,
  warehouse_id bigint NOT NULL REFERENCES shop.warehouse,
  shipping_address_id bigint NOT NULL REFERENCES shop.address,
  carrier text,
  tracking_number text UNIQUE,
  status text NOT NULL CHECK (status IN ('preparing', 'shipped', 'in_transit', 'delivered', 'returned')),
  shipped_at timestamptz,
  delivered_at timestamptz
);

CREATE TABLE shop.shipment_item (
  shipment_id bigint NOT NULL REFERENCES shop.shipment ON DELETE CASCADE,
  sales_order_line_id bigint NOT NULL REFERENCES shop.sales_order_line,
  product_id int NOT NULL REFERENCES shop.product,
  quantity int NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (shipment_id, sales_order_line_id)
);

-- A type with a closed set of values, which a grid can offer rather than make a reader spell.
CREATE TYPE shop.ticket_severity AS ENUM ('cosmetic', 'minor', 'major', 'blocking');

CREATE TABLE shop.support_ticket (
  id bigserial PRIMARY KEY,
  customer_id int NOT NULL REFERENCES shop.customer,
  sales_order_id bigint REFERENCES shop.sales_order,
  assigned_to bigint REFERENCES shop.app_user,
  subject text NOT NULL,
  severity shop.ticket_severity NOT NULL DEFAULT 'minor',
  -- How long the first answer may take: a duration, which is neither a number nor a moment.
  first_response_within interval,
  priority text NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status text NOT NULL CHECK (status IN ('open', 'waiting_customer', 'resolved', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shop.support_message (
  id bigserial PRIMARY KEY,
  ticket_id bigint NOT NULL REFERENCES shop.support_ticket ON DELETE CASCADE,
  author_user_id bigint REFERENCES shop.app_user,
  author_customer_id int REFERENCES shop.customer,
  body text NOT NULL,
  internal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((author_user_id IS NULL) <> (author_customer_id IS NULL))
);

INSERT INTO shop.organization (name, slug) VALUES
  ('Atelier Fumé', 'atelier-fume'),
  ('Logistique Atlantique', 'logistique-atlantique');

INSERT INTO shop.address (label, line1, postal_code, city, country_code) VALUES
  ('Siège', '12 rue des Fumaisons', '44000', 'Nantes', 'FR'),
  ('Entrepôt Nord', '8 quai des Docks', '59000', 'Lille', 'FR'),
  ('Entrepôt Ouest', '21 zone de Kerpont', '56100', 'Lorient', 'FR'),
  ('Alice', '4 avenue des Tilleuls', '35000', 'Rennes', 'FR'),
  ('Bob', '17 rue du Marché', '33000', 'Bordeaux', 'FR'),
  ('Chloé', '6 place des Carmes', '31000', 'Toulouse', 'FR'),
  ('Poissons du Large', '2 port de pêche', '29900', 'Concarneau', 'FR'),
  ('Épices & Terroirs', '31 rue des Saveurs', '69002', 'Lyon', 'FR');

INSERT INTO shop.app_user (organization_id, email, display_name, role) VALUES
  (1, 'admin@atelier-fume.test', 'Camille Martin', 'admin'),
  (1, 'ops@atelier-fume.test', 'Noah Bernard', 'operations'),
  (1, 'support@atelier-fume.test', 'Lina Robert', 'support'),
  (1, 'analyst@atelier-fume.test', 'Adam Petit', 'analyst'),
  (2, 'warehouse@logistique.test', 'Jade Moreau', 'operations');

UPDATE shop.app_user SET
  last_login_ip = ('192.168.1.' || (10 + id))::inet,
  last_seen_at = timestamp '2026-08-19 09:00:00' + (id * interval '3 hours 17 minutes');

INSERT INTO shop.user_profile (user_id, preferred_address_id, locale, preferences) VALUES
  (1, 1, 'fr-FR', '{"theme":"dark","notifications":true}'),
  (2, 2, 'fr-FR', '{"dashboard":"operations"}'),
  (3, 1, 'fr-FR', '{"ticketSound":false}'),
  (4, 1, 'en-GB', '{"compactNumbers":true}'),
  (5, 3, 'fr-FR', '{"dashboard":"warehouse"}');

UPDATE shop.customer SET email = CASE name
  WHEN 'Alice' THEN 'alice@example.test'
  WHEN 'Bob' THEN 'bob@example.test'
  WHEN 'Chloé' THEN 'chloe@example.test'
END;

INSERT INTO shop.customer_address (customer_id, address_id, address_kind, is_default) VALUES
  (1, 4, 'billing', true), (1, 4, 'shipping', true),
  (2, 5, 'billing', true), (2, 5, 'shipping', true),
  (3, 6, 'billing', true), (3, 6, 'shipping', true);

INSERT INTO shop.category (parent_id, name, slug, sort_order) VALUES
  (NULL, 'Poissons', 'poissons', 10),
  (NULL, 'Viandes', 'viandes', 20),
  (NULL, 'Épicerie', 'epicerie', 30),
  (1, 'Poissons fumés', 'poissons-fumes', 11),
  (2, 'Charcuteries', 'charcuteries', 21),
  (3, 'Poivres et épices', 'poivres-epices', 31);

INSERT INTO shop.brand (name, website, country_code) VALUES
  ('Fumoir Atlantique', 'https://example.test/fumoir', 'FR'),
  ('Maison du Magret', 'https://example.test/magret', 'FR'),
  ('Épices des Quais', 'https://example.test/epices', 'FR');

UPDATE shop.product SET sku = 'FA-SAUMON-250', brand_id = 1,
  description = 'Saumon fumé au bois de hêtre',
  attributes = '{"origin":{"country":"FR","region":"Bretagne","port":"Concarneau"},"weight_g":250,"allergens":["poisson"],"cure":{"salt":"sel de Guérande","days":3,"smoke":"hêtre"},"organic":true}',
  -- Left exactly as a supplier sent it: repeated spaces, a key out of order and a duplicate one.
  -- `json` keeps all three; the `attributes` above show what `jsonb` does to the same document.
  supplier_payload = '{ "ref": "F-2201",  "lot": "L-88", "ref": "F-2201-bis",
    "received": "2026-03-04" }',
  tags = ARRAY['fumé', 'poisson', 'bretagne', 'sans gluten'],
  datasheet_url = 'https://example.test/fiches/saumon-fume.pdf',
  -- A real 16x16 PNG, not a header: a grid that says "PNG image" should be able to show it.
  thumbnail = decode('89504e470d0a1a0a0000000d4948445200000010000000100802000000909168360000001e4944415478da63b8571642126218911a7e3dba44121a8c1a46639a0804002c82e9903a3822de0000000049454e44ae426082', 'hex')
  WHERE name = 'Saumon fumé';
UPDATE shop.product SET sku = 'MM-MAGRET-180', brand_id = 2,
  description = 'Magret de canard séché',
  attributes = '{"origin":{"country":"FR","region":"Landes"},"weight_g":180,"allergens":[],"cure":{"salt":"gros sel","days":21,"smoke":null},"organic":false}',
  tags = ARRAY['canard', 'séché', 'sud-ouest'],
  datasheet_url = 'https://example.test/fiches/magret-seche.pdf'
  WHERE name = 'Magret séché';
UPDATE shop.product SET sku = 'FA-TRUITE-200', brand_id = 1,
  description = 'Truite fumée tranchée',
  attributes = '{"origin":{"country":"FR","region":"Aquitaine"},"weight_g":200,"allergens":["poisson"],"cure":{"salt":"sel fin","days":2,"smoke":"chêne"},"organic":false}',
  supplier_payload = '{ "ref": "F-2202", "lot": "L-91" }',
  tags = ARRAY['fumé', 'poisson']
  WHERE name = 'Truite fumée';
UPDATE shop.product SET sku = 'EQ-POIVRE-060', brand_id = 3,
  description = 'Poivre noir fumé',
  -- A document with nothing nested in it, beside three that have plenty.
  attributes = '{"origin":{"country":"FR"},"weight_g":60,"allergens":[]}',
  tags = ARRAY[]::text[]
  WHERE name = 'Poivre fumé';

INSERT INTO shop.product_category (product_id, category_id, featured) VALUES
  (1, 4, true), (2, 5, true), (3, 4, false), (4, 6, true);

INSERT INTO shop.warehouse (organization_id, address_id, code, name, opens_at, closes_at) VALUES
  (1, 1, 'HQ', 'Stock boutique', '09:00', '19:00'),
  (2, 2, 'LIL', 'Entrepôt Lille', '06:30', '20:00'),
  (2, 3, 'LOR', 'Entrepôt Lorient', '07:00', NULL);

INSERT INTO shop.inventory (product_id, warehouse_id, quantity, reserved_quantity, reorder_level) VALUES
  (1, 1, 4, 1, 3), (1, 2, 8, 2, 5), (1, 3, 6, 0, 4),
  (2, 1, 3, 0, 3), (2, 2, 5, 1, 4), (2, 3, 7, 0, 4),
  (3, 1, 0, 0, 3), (3, 2, 4, 0, 4), (3, 3, 2, 0, 4),
  (4, 1, 12, 1, 5), (4, 2, 18, 0, 8), (4, 3, 12, 0, 6);

INSERT INTO shop.inventory_movement
  (inventory_id, performed_by, movement_type, quantity_delta, reason, occurred_at) VALUES
  (1, 2, 'receipt', 4, 'Opening stock', now() - interval '12 days'),
  (2, 5, 'receipt', 10, 'Supplier receipt', now() - interval '10 days'),
  (2, 5, 'sale', -2, 'Orders 1 and 2', now() - interval '2 days'),
  (5, 5, 'receipt', 6, 'Supplier receipt', now() - interval '8 days'),
  (5, 5, 'sale', -1, 'Order 3', now() - interval '1 day'),
  (7, 2, 'adjustment', -1, 'Damaged unit', now() - interval '5 days'),
  (10, 2, 'receipt', 14, 'Opening stock', now() - interval '15 days'),
  (10, 2, 'sale', -2, 'Retail sales', now() - interval '3 days');

-- A movement table is the one thing in a small shop that really grows: two years of daily traffic,
-- so a Data View on it pages, loads every remaining row, and shows what a long text does to a cell.
INSERT INTO shop.inventory_movement
  (inventory_id, performed_by, movement_type, quantity_delta, reason, occurred_at)
SELECT
  1 + (n % 12),
  1 + (n % 5),
  (ARRAY['receipt', 'sale', 'transfer_in', 'transfer_out', 'adjustment'])[1 + (n % 5)],
  CASE WHEN n % 3 = 0 THEN -(1 + n % 7) ELSE 1 + n % 11 END,
  CASE
    WHEN n % 97 = 0 THEN
      'Stock reconciliation after the quarterly count: ' ||
      repeat('the recorded quantity did not match the shelf, and the difference was traced to a ' ||
             'mis-scanned pallet on the receiving dock. ', 6)
    WHEN n % 5 = 0 THEN 'Warehouse transfer ' || to_char(n, 'FM000000')
    ELSE 'Movement ' || to_char(n, 'FM000000')
  END,
  now() - make_interval(mins => n * 17)
FROM generate_series(1, 4000) AS n;

INSERT INTO shop.supplier (organization_id, address_id, name, email, lead_time_days) VALUES
  (NULL, 7, 'Poissons du Large', 'commandes@poissons.test', 3),
  (NULL, 8, 'Épices & Terroirs', 'pro@epices.test', 6),
  (NULL, 1, 'Maison Canard', 'vente@canard.test', 5);

INSERT INTO shop.supplier_product
  (supplier_id, product_id, supplier_sku, unit_cost, minimum_order_quantity) VALUES
  (1, 1, 'PDL-SAU-250', 14.20, 5),
  (1, 3, 'PDL-TRU-200', 8.10, 6),
  (2, 4, 'ET-POI-060', 2.40, 12),
  (3, 2, 'MC-MAG-180', 10.00, 5);

INSERT INTO shop.purchase_order
  (supplier_id, warehouse_id, created_by, status, ordered_at, expected_at, created_at) VALUES
  (1, 3, 2, 'received', now() - interval '20 days', current_date - 17, now() - interval '21 days'),
  (2, 2, 2, 'sent', now() - interval '2 days', current_date + 4, now() - interval '3 days'),
  (3, 2, 2, 'partial', now() - interval '8 days', current_date - 1, now() - interval '9 days');

INSERT INTO shop.purchase_order_line
  (purchase_order_id, product_id, quantity, received_quantity, unit_cost) VALUES
  (1, 1, 10, 10, 14.20), (1, 3, 12, 12, 8.10),
  (2, 4, 24, 0, 2.40), (3, 2, 10, 6, 10.00);

INSERT INTO shop.promotion (code, name, discount_rate, season, starts_at, ends_at) VALUES
  -- One range closed at both ends, one open at the far end, one absent altogether.
  ('WELCOME10', 'Bienvenue', 0.10, daterange('2026-01-01', '2026-12-31', '[]'),
   now() - interval '30 days', now() + interval '60 days'),
  ('FISH15', 'Semaine du poisson', 0.15, daterange('2026-08-01', NULL),
   now() - interval '3 days', now() + interval '4 days'),
  ('SPICE20', 'Découverte des épices', 0.20, NULL,
   now() + interval '10 days', now() + interval '20 days');

INSERT INTO shop.promotion_product (promotion_id, product_id) VALUES
  (2, 1), (2, 3), (3, 4);

INSERT INTO shop.sales_order
  (customer_id, billing_address_id, shipping_address_id, created_by, status,
   subtotal, discount_total, tax_total, grand_total, placed_at, created_at, updated_at) VALUES
  (1, 4, 4, 2, 'completed', 49.80, 4.98, 8.96, 53.78,
   now() - interval '18 days', now() - interval '18 days', now() - interval '15 days'),
  (2, 5, 5, 2, 'shipped', 37.00, 0, 7.40, 44.40,
   now() - interval '6 days', now() - interval '6 days', now() - interval '2 days'),
  (3, 6, 6, 1, 'paid', 31.40, 3.14, 5.65, 33.91,
   now() - interval '2 days', now() - interval '2 days', now() - interval '1 day'),
  (1, 4, 4, 2, 'confirmed', 25.60, 0, 5.12, 30.72,
   now() - interval '3 hours', now() - interval '3 hours', now() - interval '3 hours'),
  (2, 5, 5, NULL, 'draft', 15.00, 0, 3.00, 18.00,
   NULL, now() - interval '1 hour', now() - interval '1 hour');

INSERT INTO shop.sales_order_line
  (sales_order_id, product_id, promotion_id, quantity, unit_price, discount_rate, line_total) VALUES
  (1, 1, 1, 2, 24.90, 0.10, 44.82),
  (2, 2, NULL, 2, 18.50, 0, 37.00),
  (3, 1, 2, 1, 24.90, 0.15, 21.17),
  (3, 4, NULL, 1, 6.40, 0, 6.40),
  (4, 4, NULL, 4, 6.40, 0, 25.60),
  (5, 3, NULL, 1, 15.00, 0, 15.00);

INSERT INTO shop.payment
  (sales_order_id, provider, provider_reference, status, amount, paid_at, created_at) VALUES
  (1, 'stripe', 'pay_demo_001', 'captured', 53.78, now() - interval '18 days', now() - interval '18 days'),
  (2, 'paypal', 'pay_demo_002', 'captured', 44.40, now() - interval '6 days', now() - interval '6 days'),
  (3, 'stripe', 'pay_demo_003', 'captured', 33.91, now() - interval '2 days', now() - interval '2 days'),
  (4, 'stripe', 'pay_demo_004', 'authorized', 30.72, NULL, now() - interval '3 hours');

INSERT INTO shop.refund
  (payment_id, requested_by, status, amount, reason, created_at, processed_at) VALUES
  (1, 3, 'processed', 6.40, 'Article manquant dans le colis',
   now() - interval '12 days', now() - interval '11 days');

INSERT INTO shop.shipment
  (sales_order_id, warehouse_id, shipping_address_id, carrier, tracking_number,
   status, shipped_at, delivered_at) VALUES
  (1, 3, 4, 'Colissimo', 'DEMO-FR-0001', 'delivered',
   now() - interval '17 days', now() - interval '15 days'),
  (2, 2, 5, 'Chronopost', 'DEMO-FR-0002', 'in_transit',
   now() - interval '2 days', NULL),
  (3, 1, 6, NULL, NULL, 'preparing', NULL, NULL);

INSERT INTO shop.shipment_item (shipment_id, sales_order_line_id, product_id, quantity) VALUES
  (1, 1, 1, 2), (2, 2, 2, 2), (3, 3, 1, 1), (3, 4, 4, 1);

INSERT INTO shop.support_ticket
  (customer_id, sales_order_id, assigned_to, subject, severity, first_response_within,
   priority, status, created_at, updated_at) VALUES
  (1, 1, 3, 'Article manquant', 'major', interval '2 hours',
   'high', 'resolved', now() - interval '13 days', now() - interval '11 days'),
  (2, 2, 3, 'Suivi de livraison', 'minor', interval '1 day',
   'normal', 'waiting_customer', now() - interval '1 day', now() - interval '6 hours'),
  (3, NULL, NULL, 'Conseil de conservation', 'cosmetic', interval '3 days 4 hours 30 minutes',
   'low', 'open', now() - interval '2 hours', now() - interval '2 hours');

INSERT INTO shop.support_message
  (ticket_id, author_user_id, author_customer_id, body, internal, created_at) VALUES
  (1, NULL, 1, 'Il manque le poivre dans mon colis.', false, now() - interval '13 days'),
  (1, 3, NULL, 'Nous procédons à un remboursement partiel.', false, now() - interval '12 days'),
  (1, 3, NULL, 'Remboursement confirmé dans Stripe.', true, now() - interval '11 days'),
  (2, NULL, 2, 'Le suivi ne bouge plus depuis hier.', false, now() - interval '1 day'),
  (2, 3, NULL, 'Le colis est toujours en transit. Pouvez-vous vérifier demain ?', false, now() - interval '6 hours'),
  (3, NULL, 3, 'Combien de temps conserver le saumon après ouverture ?', false, now() - interval '2 hours');

CREATE VIEW shop.product_availability AS
SELECT
  product.id AS product_id,
  product.sku,
  product.name AS product_name,
  brand.name AS brand_name,
  sum(inventory.quantity) AS total_quantity,
  sum(inventory.reserved_quantity) AS reserved_quantity,
  sum(inventory.quantity - inventory.reserved_quantity) AS available_quantity,
  count(DISTINCT inventory.warehouse_id) AS warehouse_count
FROM shop.product
LEFT JOIN shop.brand ON brand.id = product.brand_id
LEFT JOIN shop.inventory ON inventory.product_id = product.id
GROUP BY product.id, product.sku, product.name, brand.name;

CREATE VIEW shop.order_overview AS
WITH line_totals AS (
  SELECT sales_order_id, count(*) AS line_count, sum(quantity) AS item_count
  FROM shop.sales_order_line
  GROUP BY sales_order_id
), payment_totals AS (
  SELECT sales_order_id, sum(amount) FILTER (WHERE status IN ('captured', 'refunded')) AS paid_amount
  FROM shop.payment
  GROUP BY sales_order_id
), shipment_totals AS (
  SELECT sales_order_id, count(*) AS shipment_count, max(status) AS latest_shipment_status
  FROM shop.shipment
  GROUP BY sales_order_id
)
SELECT
  sales_order.id AS order_id,
  customer.name AS customer_name,
  sales_order.status,
  sales_order.grand_total,
  coalesce(line_totals.line_count, 0) AS line_count,
  coalesce(line_totals.item_count, 0) AS item_count,
  coalesce(payment_totals.paid_amount, 0) AS paid_amount,
  coalesce(shipment_totals.shipment_count, 0) AS shipment_count,
  shipment_totals.latest_shipment_status,
  sales_order.placed_at
FROM shop.sales_order
JOIN shop.customer ON customer.id = sales_order.customer_id
LEFT JOIN line_totals ON line_totals.sales_order_id = sales_order.id
LEFT JOIN payment_totals ON payment_totals.sales_order_id = sales_order.id
LEFT JOIN shipment_totals ON shipment_totals.sales_order_id = sales_order.id;

CREATE VIEW shop.support_queue AS
SELECT
  support_ticket.id AS ticket_id,
  support_ticket.priority,
  support_ticket.status,
  support_ticket.subject,
  customer.name AS customer_name,
  app_user.display_name AS assigned_to,
  sales_order.status AS order_status,
  support_ticket.updated_at
FROM shop.support_ticket
JOIN shop.customer ON customer.id = support_ticket.customer_id
LEFT JOIN shop.app_user ON app_user.id = support_ticket.assigned_to
LEFT JOIN shop.sales_order ON sales_order.id = support_ticket.sales_order_id
WHERE support_ticket.status NOT IN ('resolved', 'closed');

CREATE OR REPLACE FUNCTION shop.available_inventory(p_product_id int)
RETURNS int
LANGUAGE sql
STABLE
AS $sql$
  SELECT coalesce(sum(quantity - reserved_quantity), 0)::int
  FROM shop.inventory
  WHERE product_id = p_product_id
$sql$;

CREATE OR REPLACE FUNCTION shop.customer_revenue(p_customer_id int)
RETURNS numeric
LANGUAGE sql
STABLE
AS $sql$
  SELECT coalesce(sum(grand_total), 0)
  FROM shop.sales_order
  WHERE customer_id = p_customer_id
    AND status IN ('paid', 'shipped', 'completed')
$sql$;

CREATE OR REPLACE FUNCTION shop.reprice_order(p_order_id bigint)
RETURNS shop.sales_order
LANGUAGE plpgsql
AS $function$
DECLARE
  result shop.sales_order;
BEGIN
  UPDATE shop.sales_order_line
  SET line_total = round(unit_price * quantity * (1 - discount_rate), 2)
  WHERE sales_order_id = p_order_id;

  UPDATE shop.sales_order
  SET subtotal = totals.subtotal,
      discount_total = totals.discount_total,
      tax_total = round((totals.subtotal - totals.discount_total) * 0.20, 2),
      grand_total = round((totals.subtotal - totals.discount_total) * 1.20, 2),
      updated_at = now()
  FROM (
    SELECT
      coalesce(sum(unit_price * quantity), 0) AS subtotal,
      coalesce(sum(unit_price * quantity - line_total), 0) AS discount_total
    FROM shop.sales_order_line
    WHERE sales_order_id = p_order_id
  ) AS totals
  WHERE sales_order.id = p_order_id
  RETURNING sales_order.* INTO result;

  RETURN result;
END;
$function$;

CREATE OR REPLACE PROCEDURE shop.move_inventory(
  p_product_id int,
  p_from_warehouse_id bigint,
  p_to_warehouse_id bigint,
  p_quantity int,
  p_user_id bigint
)
LANGUAGE plpgsql
AS $procedure$
DECLARE
  source_inventory shop.inventory;
  target_inventory shop.inventory;
BEGIN
  IF p_quantity <= 0 THEN
    RAISE EXCEPTION 'Transfer quantity must be positive';
  END IF;

  SELECT * INTO STRICT source_inventory
  FROM shop.inventory
  WHERE product_id = p_product_id AND warehouse_id = p_from_warehouse_id
  FOR UPDATE;

  SELECT * INTO STRICT target_inventory
  FROM shop.inventory
  WHERE product_id = p_product_id AND warehouse_id = p_to_warehouse_id
  FOR UPDATE;

  IF source_inventory.quantity - source_inventory.reserved_quantity < p_quantity THEN
    RAISE EXCEPTION 'Not enough available inventory for product %', p_product_id;
  END IF;

  UPDATE shop.inventory
  SET quantity = quantity - p_quantity, updated_at = now()
  WHERE id = source_inventory.id;

  UPDATE shop.inventory
  SET quantity = quantity + p_quantity, updated_at = now()
  WHERE id = target_inventory.id;

  INSERT INTO shop.inventory_movement
    (inventory_id, performed_by, movement_type, quantity_delta, reason)
  VALUES
    (source_inventory.id, p_user_id, 'transfer_out', -p_quantity, 'Warehouse transfer'),
    (target_inventory.id, p_user_id, 'transfer_in', p_quantity, 'Warehouse transfer');
END;
$procedure$;

-- A table whose two ways of holding nothing are worth telling apart. `status` is nullable and
-- carries a default, so leaving it out of an INSERT and giving it NULL write two different rows:
-- one holds 'pending', the other holds nothing at all. `note` has no default, where the two agree.
CREATE TABLE shop.stock_check (
  id bigserial PRIMARY KEY,
  counted_by text NOT NULL,
  note text,
  status text DEFAULT 'pending',
  checked_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO shop.stock_check (counted_by, note, status) VALUES
  ('Amélie', 'Comptage mensuel', 'done'),
  ('Bruno', NULL, 'pending');
