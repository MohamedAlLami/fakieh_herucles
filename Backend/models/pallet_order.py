"""Event-based pallet orders and routing movements."""

from datetime import datetime, timezone

from sqlalchemy import CheckConstraint, Index, UniqueConstraint, text

from . import db


def utc_now():
    return datetime.now(timezone.utc)


class PalletOrderSequence(db.Model):
    __tablename__ = "pallet_order_sequences"

    line = db.Column(db.String(10), primary_key=True)
    last_sequence = db.Column(db.Integer, nullable=False, default=0)


class PalletOrder(db.Model):
    __tablename__ = "pallet_orders"
    __table_args__ = (
        CheckConstraint("line IN ('P1', 'P2', 'P3', 'P4')", name="ck_pallet_orders_line"),
        CheckConstraint("status IN ('RUNNING', 'COMPLETED')", name="ck_pallet_orders_status"),
        UniqueConstraint("line", "order_sequence", name="uq_pallet_orders_line_sequence"),
        Index("ix_pallet_orders_line", "line"),
        Index("ix_pallet_orders_status", "status"),
        Index("ix_pallet_orders_actual_start", "actual_start_time"),
        Index("ix_pallet_orders_line_start", "line", "actual_start_time"),
        Index("ix_pallet_orders_line_status", "line", "status"),
        Index(
            "uq_pallet_orders_active_line",
            "line",
            unique=True,
            postgresql_where=text("status = 'RUNNING'"),
        ),
    )

    id = db.Column(db.BigInteger, primary_key=True, autoincrement=True)
    line = db.Column(db.String(10), nullable=False)
    order_sequence = db.Column(db.Integer, nullable=False)
    order_description = db.Column(db.String(50), nullable=False)
    source1 = db.Column(db.Integer, nullable=True)
    source2 = db.Column(db.Integer, nullable=True)
    destination1 = db.Column(db.Integer, nullable=True)
    destination2 = db.Column(db.Integer, nullable=True)
    production_name = db.Column(db.String(255), nullable=True)
    material = db.Column(db.String(255), nullable=True)
    start_qty = db.Column(db.Float, nullable=True)
    latest_qty = db.Column(db.Float, nullable=True)
    final_qty = db.Column(db.Float, nullable=True)
    running = db.Column(db.Boolean, nullable=False, default=True)
    status = db.Column(db.String(20), nullable=False, default="RUNNING")
    selection = db.Column(db.Integer, nullable=True)
    actual_start_time = db.Column(db.DateTime(timezone=True), nullable=False, default=utc_now)
    actual_end_time = db.Column(db.DateTime(timezone=True), nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now)

    movements = db.relationship(
        "PalletOrderMovement",
        back_populates="order",
        cascade="all, delete-orphan",
        lazy="selectin",
        order_by="PalletOrderMovement.observed_at",
    )

    @property
    def product_kg(self):
        return self.final_qty if self.status == "COMPLETED" else self.latest_qty

    def to_dict(self):
        end = self.actual_end_time or datetime.now(timezone.utc)
        start = self.actual_start_time
        duration = max(0, int((end - start).total_seconds())) if start else None
        return {
            "id": self.id,
            "line": self.line,
            "order_sequence": self.order_sequence,
            "order_description": self.order_description,
            "source1": self.source1,
            "source2": self.source2,
            "destination1": self.destination1,
            "destination2": self.destination2,
            "production_name": self.production_name,
            "material": self.material,
            "start_qty": self.start_qty,
            "latest_qty": self.latest_qty,
            "final_qty": self.final_qty,
            "product_kg": self.product_kg,
            "running": self.running,
            "status": self.status,
            "selection": self.selection,
            "actual_start_time": self.actual_start_time.isoformat() if self.actual_start_time else None,
            "actual_end_time": self.actual_end_time.isoformat() if self.actual_end_time else None,
            "duration_seconds": duration,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
            "movements": [movement.to_dict() for movement in self.movements],
        }

class PalletOrderMovement(db.Model):
    __tablename__ = "pallet_order_movements"
    __table_args__ = (
        Index("ix_pallet_order_movements_order", "pallet_order_id"),
        Index("ix_pallet_order_movements_observed", "observed_at"),
    )

    id = db.Column(db.BigInteger, primary_key=True, autoincrement=True)
    pallet_order_id = db.Column(
        db.BigInteger,
        db.ForeignKey("pallet_orders.id", ondelete="CASCADE"),
        nullable=False,
    )
    source1 = db.Column(db.Integer, nullable=True)
    source2 = db.Column(db.Integer, nullable=True)
    destination1 = db.Column(db.Integer, nullable=True)
    destination2 = db.Column(db.Integer, nullable=True)
    quantity = db.Column(db.Float, nullable=True)
    selection = db.Column(db.Integer, nullable=True)
    observed_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utc_now)

    order = db.relationship("PalletOrder", back_populates="movements")

    def to_dict(self):
        return {
            "id": self.id,
            "source1": self.source1,
            "source2": self.source2,
            "destination1": self.destination1,
            "destination2": self.destination2,
            "quantity": self.quantity,
            "selection": self.selection,
            "observed_at": self.observed_at.isoformat() if self.observed_at else None,
        }
