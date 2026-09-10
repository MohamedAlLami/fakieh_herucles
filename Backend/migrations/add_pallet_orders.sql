BEGIN;

CREATE TABLE IF NOT EXISTS pallet_order_sequences (
    line VARCHAR(10) PRIMARY KEY,
    last_sequence INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pallet_orders (
    id BIGSERIAL PRIMARY KEY,
    line VARCHAR(10) NOT NULL,
    order_sequence INTEGER NOT NULL,
    order_description VARCHAR(50) NOT NULL,
    source1 INTEGER NULL,
    source2 INTEGER NULL,
    destination1 INTEGER NULL,
    destination2 INTEGER NULL,
    production_name VARCHAR(255) NULL,
    material VARCHAR(255) NULL,
    start_qty DOUBLE PRECISION NULL,
    latest_qty DOUBLE PRECISION NULL,
    final_qty DOUBLE PRECISION NULL,
    running BOOLEAN NOT NULL DEFAULT TRUE,
    status VARCHAR(20) NOT NULL,
    selection INTEGER NULL,
    actual_start_time TIMESTAMPTZ NOT NULL,
    actual_end_time TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_pallet_orders_line CHECK (line IN ('P1', 'P2', 'P3', 'P4')),
    CONSTRAINT ck_pallet_orders_status CHECK (status IN ('RUNNING', 'COMPLETED')),
    CONSTRAINT uq_pallet_orders_line_sequence UNIQUE (line, order_sequence)
);

CREATE TABLE IF NOT EXISTS pallet_order_movements (
    id BIGSERIAL PRIMARY KEY,
    pallet_order_id BIGINT NOT NULL REFERENCES pallet_orders(id) ON DELETE CASCADE,
    source1 INTEGER NULL,
    source2 INTEGER NULL,
    destination1 INTEGER NULL,
    destination2 INTEGER NULL,
    quantity DOUBLE PRECISION NULL,
    selection INTEGER NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ix_pallet_orders_line ON pallet_orders (line);
CREATE INDEX IF NOT EXISTS ix_pallet_orders_status ON pallet_orders (status);
CREATE INDEX IF NOT EXISTS ix_pallet_orders_actual_start ON pallet_orders (actual_start_time);
CREATE INDEX IF NOT EXISTS ix_pallet_orders_line_start ON pallet_orders (line, actual_start_time);
CREATE INDEX IF NOT EXISTS ix_pallet_orders_line_status ON pallet_orders (line, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pallet_orders_active_line
    ON pallet_orders (line) WHERE status = 'RUNNING';
CREATE INDEX IF NOT EXISTS ix_pallet_order_movements_order
    ON pallet_order_movements (pallet_order_id);
CREATE INDEX IF NOT EXISTS ix_pallet_order_movements_observed
    ON pallet_order_movements (observed_at);

COMMIT;
