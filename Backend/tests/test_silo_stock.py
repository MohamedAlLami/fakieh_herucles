import unittest

from services.silo_stock import NOT_CONFIRMED_NOTE, apply_stock_delta, compute_new_qty


class FakePlc:
    def __init__(self, value=1000.0, readable=True, stick=False):
        self.value, self.readable, self.stick = value, readable, stick
        self.writes = []

    def read(self, silo):
        return self.value if self.readable else None

    def write(self, silo, qty):
        self.writes.append((silo, qty))
        if not self.stick:
            self.value = qty


class FakeDb:
    def __init__(self, stored=500.0):
        self.stored, self.calls = stored, []

    def update(self, silo, delta, absolute):
        self.calls.append((silo, delta, absolute))
        before = self.stored
        self.stored = absolute if absolute is not None else max(before + delta, 0.0)
        return before, self.stored


def run(delta, plc=None, db=None, **kw):
    plc = plc or FakePlc()
    db = db or FakeDb()
    kw.setdefault("writes_enabled", True)
    kw.setdefault("has_address", True)
    res = apply_stock_delta(104, delta, reader=plc.read, writer=plc.write, db_updater=db.update, **kw)
    return res, plc, db


class ComputeNewQtyTests(unittest.TestCase):
    def test_gain(self):
        self.assertEqual(compute_new_qty(1000, 26400), (27400.0, False))

    def test_loss(self):
        self.assertEqual(compute_new_qty(1000, -400), (600.0, False))

    def test_below_zero_is_not_clamped(self):
        # The PLC itself runs silos negative; hiding that would falsify the books.
        self.assertEqual(compute_new_qty(100, -250), (-150.0, True))

    def test_negative_start_gains_normally(self):
        self.assertEqual(compute_new_qty(-28.935, 1000), (971.065, False))

    def test_exact_zero_not_flagged(self):
        self.assertEqual(compute_new_qty(100, -100), (0.0, False))

    def test_rounding(self):
        self.assertEqual(compute_new_qty(1.00049, 0.0004), (1.001, False))


class ApplyStockDeltaTests(unittest.TestCase):
    def test_applied_gain_writes_plc_and_db(self):
        res, plc, db = run(26400.0)
        self.assertEqual(res["status"], "applied")
        self.assertEqual((res["qty_before"], res["qty_after"]), (1000.0, 27400.0))
        self.assertEqual(plc.writes, [(104, 27400.0)])
        self.assertEqual(db.calls, [(104, 26400.0, 27400.0)])

    def test_signed_loss_reduces_silo(self):
        res, plc, _ = run(-300.0)
        self.assertEqual(res["status"], "applied")
        self.assertEqual(res["qty_after"], 700.0)
        self.assertEqual(plc.writes, [(104, 700.0)])

    def test_below_zero_is_written_and_noted(self):
        res, plc, _ = run(-5000.0)
        self.assertEqual(res["status"], "applied")
        self.assertEqual(res["qty_after"], -4000.0)
        self.assertEqual(plc.writes, [(104, -4000.0)])
        self.assertIn("below zero", res["note"])

    def test_writes_disabled_is_db_only(self):
        res, plc, db = run(100.0, writes_enabled=False)
        self.assertEqual(res["status"], "pending")
        self.assertIn("disabled", res["note"])
        self.assertEqual(plc.writes, [])
        self.assertEqual((res["qty_before"], res["qty_after"]), (500.0, 600.0))
        self.assertTrue(res["db_applied"])

    def test_no_address(self):
        res, plc, db = run(100.0, has_address=False)
        self.assertEqual(res["status"], "pending")
        self.assertIn("no known PLC block", res["note"])
        self.assertEqual(plc.writes, [])
        self.assertEqual(db.stored, 600.0)

    def test_read_failure(self):
        res, plc, db = run(100.0, plc=FakePlc(readable=False))
        self.assertEqual(res["status"], "pending")
        self.assertIn("not reachable", res["note"])
        self.assertEqual(plc.writes, [])
        self.assertEqual(db.stored, 600.0)

    def test_write_not_confirmed(self):
        res, plc, db = run(100.0, plc=FakePlc(stick=True))
        self.assertEqual(res["status"], "pending")
        self.assertIn(NOT_CONFIRMED_NOTE, res["note"])
        self.assertEqual(res["qty_before"], 1000.0)

    def test_db_failure_never_raises(self):
        def boom(*a):
            raise RuntimeError("db down")
        res = apply_stock_delta(104, 10, reader=lambda s: None, writer=lambda *a: None,
                                db_updater=boom, writes_enabled=False)
        self.assertEqual(res["status"], "pending")
        self.assertFalse(res["db_applied"])

    def test_retry_does_not_double_apply_db(self):
        db = FakeDb()
        first, _, _ = run(100.0, db=db, writes_enabled=False)
        self.assertTrue(first["db_applied"])
        self.assertEqual(db.stored, 600.0)
        res, plc, _ = run(100.0, db=db, db_already_applied=True)
        self.assertEqual(res["status"], "applied")
        self.assertEqual(plc.writes, [(104, 1100.0)])
        # only the PLC-authoritative absolute sync, no second delta
        self.assertEqual(db.calls[-1], (104, 100.0, 1100.0))
        self.assertEqual(db.stored, 1100.0)

    def test_retry_after_unconfirmed_write_that_landed(self):
        plc = FakePlc(value=1100.0)  # earlier write did land
        res, plc, _ = run(100.0, plc=plc, db_already_applied=True, plc_before_attempt=1000.0)
        self.assertEqual(res["status"], "applied")
        self.assertEqual(plc.writes, [])

    def test_retry_pending_db_failure_keeps_db_flag(self):
        res, _, _ = run(100.0, writes_enabled=False, db_already_applied=True)
        self.assertEqual(res["status"], "pending")
        self.assertTrue(res["db_applied"])

    def test_zero_delta_skipped(self):
        res, plc, db = run(0.0)
        self.assertEqual(res["status"], "skipped")
        self.assertEqual(plc.writes, [])



class ReasonNoteTests(unittest.TestCase):
    def test_block_error_text_becomes_the_note(self):
        class SiloBlockError(RuntimeError):
            pass

        def reader(_silo):
            raise SiloBlockError("PLC block DB6204 no longer belongs to silo 103")

        res = apply_stock_delta(103, 500.0, reader=reader, writer=lambda *a: self.fail("must not write"),
                                db_updater=lambda s, d, a: (0.0, 500.0), writes_enabled=True, has_address=True)
        self.assertEqual(res["status"], "pending")
        self.assertIn("no longer belongs to silo 103", res["note"])


class WriteSwitchTests(unittest.TestCase):
    def test_off_by_default_and_env_overrides_file(self):
        import os
        from unittest import mock
        from services import silo_stock
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("WEIGHBRIDGE_WRITE_SILO_QTY", None)
            with mock.patch.object(silo_stock, "plc_write_flag_path", return_value="Z:/no/such/file.txt"):
                self.assertFalse(silo_stock.plc_writes_enabled())
            os.environ["WEIGHBRIDGE_WRITE_SILO_QTY"] = "false"
            with mock.patch.object(silo_stock, "plc_write_flag_path", return_value=__file__):
                self.assertFalse(silo_stock.plc_writes_enabled())      # env says off, file says on

if __name__ == "__main__":
    unittest.main()


class ClassifySilosTests(unittest.TestCase):
    ROWS = [
        {"siloNo": 101, "materialCode": "100", "materialName": "Maize", "quantityKg": 5, "lockActive": False},
        {"siloNo": 401, "materialCode": "12", "materialName": "Methionine", "quantityKg": 1, "lockActive": False},
        {"siloNo": 301, "materialCode": "00", "materialName": "", "quantityKg": 0, "lockActive": False},
        {"siloNo": 313, "materialCode": "", "materialName": "", "quantityKg": 0, "lockActive": False},
        {"siloNo": 315, "materialCode": "999", "materialName": "Out Of Service", "quantityKg": 0, "lockActive": True},
        {"siloNo": 601, "materialCode": None, "materialName": None, "quantityKg": 0, "lockActive": False},
    ]

    def test_leading_zero_match(self):
        from services.silo_stock import classify_silos
        out = classify_silos(self.ROWS, "012")
        self.assertEqual([s["siloNo"] for s in out["matching"]], [401])

    def test_unassigned_and_out_of_service(self):
        from services.silo_stock import classify_silos
        out = classify_silos(self.ROWS, "100")
        self.assertEqual([s["siloNo"] for s in out["matching"]], [101])
        # 601 has no material name either, but pellet / micro bins are never offered to a truck
        self.assertEqual([s["siloNo"] for s in out["unassigned"]], [301, 313])
