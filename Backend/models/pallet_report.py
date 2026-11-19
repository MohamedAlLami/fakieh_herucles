"""PostgreSQL model for one-minute pallet historian snapshots."""

from datetime import datetime, timezone

from sqlalchemy import CheckConstraint, Index, UniqueConstraint

from . import db


def utc_now():
    return datetime.now(timezone.utc)


class PalletReport(db.Model):
    __tablename__ = "pallet_report"
    __table_args__ = (
        CheckConstraint("line IN ('P1', 'P2', 'P3', 'P4')", name="ck_pallet_report_line"),
        Index("ix_pallet_report_recorded_at", "recorded_at"),
        Index("ix_pallet_report_line", "line"),
        Index("ix_pallet_report_line_recorded_at", "line", "recorded_at"),
        UniqueConstraint("line", "recorded_at", name="uq_pallet_report_line_minute"),
    )

    id = db.Column(db.BigInteger, primary_key=True, autoincrement=True)
    line = db.Column(db.String(2), nullable=False)
    source1 = db.Column(db.Integer, nullable=False)
    source2 = db.Column(db.Integer, nullable=True)
    destination1 = db.Column(db.Integer, nullable=True)
    destination2 = db.Column(db.Integer, nullable=True)
    quantity = db.Column(db.Float, nullable=False)
    running = db.Column(db.Boolean, nullable=False, default=True)
    # PLC FullRun bit at this minute; NULL on rows stored before the bit existed.
    full_run = db.Column(db.Boolean, nullable=True)
    selection = db.Column(db.Integer, nullable=True)
    recorded_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utc_now)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utc_now)

    def to_dict(self):
        return {
            "id": self.id,
            "line": self.line,
            "source1": self.source1,
            "source2": self.source2,
            "destination1": self.destination1,
            "destination2": self.destination2,
            "quantity": self.quantity,
            "running": self.running,
            "full_run": self.full_run,
            "selection": self.selection,
            "recorded_at": self.recorded_at.isoformat() if self.recorded_at else None,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


def ensure_pallet_run_columns():
    """Add the full-run / actual-run columns on existing installs (idempotent)."""
    from sqlalchemy import inspect, text

    insp = inspect(db.engine)
    statements = []
    if insp.has_table("pallet_report"):
        statements.append("ALTER TABLE pallet_report ADD COLUMN IF NOT EXISTS full_run BOOLEAN")
    if insp.has_table("pallet_orders"):
        statements += [
            "ALTER TABLE pallet_orders ADD COLUMN IF NOT EXISTS active_seconds DOUBLE PRECISION",
            "ALTER TABLE pallet_orders ADD COLUMN IF NOT EXISTS last_running BOOLEAN",
            "ALTER TABLE pallet_orders ADD COLUMN IF NOT EXISTS last_observed_at TIMESTAMPTZ",
        ]
    try:
        for stmt in statements:
            db.session.execute(text(stmt))
        db.session.commit()
    except Exception:
        db.session.rollback()
        raise
