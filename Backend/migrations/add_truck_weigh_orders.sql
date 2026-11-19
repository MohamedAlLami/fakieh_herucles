-- Truck weighbridge orders: truck + material, two manual weights, NET on completion
CREATE TABLE IF NOT EXISTS truck_weigh_orders (
    id               BIGSERIAL PRIMARY KEY,
    ticket           VARCHAR(32) NOT NULL UNIQUE,
    truck_id         INTEGER NOT NULL,
    material_code    VARCHAR(50) NOT NULL,
    material_name    VARCHAR(200),
    first_weight_kg  DOUBLE PRECISION,
    first_ts         TIMESTAMPTZ,
    second_weight_kg DOUBLE PRECISION,
    second_ts        TIMESTAMPTZ,
    net_kg           DOUBLE PRECISION,
    status           VARCHAR(20) NOT NULL DEFAULT 'awaiting_first',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_truck_weigh_orders_truck_id ON truck_weigh_orders (truck_id);
CREATE INDEX IF NOT EXISTS ix_truck_weigh_orders_status ON truck_weigh_orders (status);
CREATE INDEX IF NOT EXISTS ix_truck_weigh_orders_created_at ON truck_weigh_orders (created_at);

-- Silo stock outcome (weighbridge trip -> silo quantity). stock_delta_kg is signed.
ALTER TABLE truck_weigh_orders ADD COLUMN IF NOT EXISTS silo_no INTEGER;
ALTER TABLE truck_weigh_orders ADD COLUMN IF NOT EXISTS stock_delta_kg DOUBLE PRECISION;
ALTER TABLE truck_weigh_orders ADD COLUMN IF NOT EXISTS stock_status VARCHAR(20);
ALTER TABLE truck_weigh_orders ADD COLUMN IF NOT EXISTS stock_qty_before DOUBLE PRECISION;
ALTER TABLE truck_weigh_orders ADD COLUMN IF NOT EXISTS stock_qty_after DOUBLE PRECISION;
ALTER TABLE truck_weigh_orders ADD COLUMN IF NOT EXISTS stock_applied_at TIMESTAMPTZ;
ALTER TABLE truck_weigh_orders ADD COLUMN IF NOT EXISTS stock_note VARCHAR(255);
