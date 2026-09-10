BEGIN;

CREATE TABLE IF NOT EXISTS pallet_report (
    id BIGSERIAL PRIMARY KEY,
    line VARCHAR(2) NOT NULL,
    source1 INTEGER NOT NULL,
    source2 INTEGER NULL,
    destination1 INTEGER NULL,
    destination2 INTEGER NULL,
    quantity DOUBLE PRECISION NOT NULL,
    running BOOLEAN NOT NULL DEFAULT TRUE,
    selection INTEGER NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_pallet_report_line CHECK (line IN ('P1', 'P2', 'P3', 'P4')),
    CONSTRAINT uq_pallet_report_line_minute UNIQUE (line, recorded_at)
);

CREATE INDEX IF NOT EXISTS ix_pallet_report_recorded_at
    ON pallet_report (recorded_at);
CREATE INDEX IF NOT EXISTS ix_pallet_report_line
    ON pallet_report (line);
CREATE INDEX IF NOT EXISTS ix_pallet_report_line_recorded_at
    ON pallet_report (line, recorded_at);

COMMIT;
