CREATE TABLE order_lines (
  order_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  sku TEXT NOT NULL REFERENCES items (sku),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (order_id, line_no)
);
