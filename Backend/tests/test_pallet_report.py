import struct
import unittest
from unittest.mock import Mock

from services.pallet_report_service import (
    PalletPLCReadError,
    build_live_lines,
    build_snapshot_rows,
    collect_pallet_history,
    decode_pallet_db7,
)


def pallet_data(p1=False, p2=False, shared=False, selection=0):
    return {
        "P1": {
            "source1": 101,
            "source2": 102,
            "destination1": 201,
            "destination2": 202,
            "quantity": 500.25,
            "running": p1,
        },
        "P2": {
            "source1": 301,
            "source2": 302,
            "destination1": 401,
            "destination2": 402,
            "quantity": 600.5,
            "running": p2,
        },
        "P3_P4": {
            "source": 605,
            "destination1": 701,
            "destination2": 702,
            "quantity": 250.5,
            "running": shared,
            "selection": selection,
        },
    }


class PalletBusinessLogicTests(unittest.TestCase):
    def assert_lines(self, expected, **kwargs):
        self.assertEqual(expected, [r["line"] for r in build_snapshot_rows(pallet_data(**kwargs))])

    def test_p1_running_and_stopped(self):
        self.assert_lines(["P1"], p1=True)
        self.assert_lines([], p1=False)

    def test_p2_running_and_stopped(self):
        self.assert_lines(["P2"], p2=True)
        self.assert_lines([], p2=False)

    def test_shared_selection_3(self):
        self.assert_lines(["P3"], shared=True, selection=3)

    def test_shared_selection_4(self):
        self.assert_lines(["P4"], shared=True, selection=4)

    def test_shared_selection_5(self):
        rows = build_snapshot_rows(pallet_data(shared=True, selection=5))
        self.assertEqual(["P3", "P4"], [r["line"] for r in rows])
        self.assertTrue(all(r["selection"] == 5 for r in rows))

    def test_stopped_shared_line_never_creates_rows(self):
        for selection in (3, 4, 5):
            self.assert_lines([], shared=False, selection=selection)

    def test_invalid_selection_is_ignored(self):
        self.assert_lines([], shared=True, selection=7)

    def test_live_shared_status_requires_selection_and_running(self):
        lines = build_live_lines(pallet_data(shared=True, selection=3))
        self.assertTrue(lines["P3"]["running"])
        self.assertFalse(lines["P4"]["running"])

        lines = build_live_lines(pallet_data(shared=False, selection=5))
        self.assertFalse(lines["P3"]["running"])
        self.assertFalse(lines["P4"]["running"])

    def test_snapshot_timestamp_is_canonicalized_to_minute(self):
        from datetime import datetime, timezone

        timestamp = datetime(2026, 9, 10, 12, 34, 56, 789, tzinfo=timezone.utc)
        row = build_snapshot_rows(pallet_data(p1=True), timestamp)[0]
        self.assertEqual(0, row["recorded_at"].second)
        self.assertEqual(0, row["recorded_at"].microsecond)


class PalletDecoderTests(unittest.TestCase):
    def test_int_real_and_bool_decoding(self):
        raw = bytearray(42)
        struct.pack_into(">h", raw, 0, -123)
        struct.pack_into(">h", raw, 2, 456)
        raw[8] = 0b00000001
        struct.pack_into(">f", raw, 10, 321.75)
        struct.pack_into(">h", raw, 28, 605)
        raw[34] = 0b00000001
        struct.pack_into(">h", raw, 36, 5)
        struct.pack_into(">f", raw, 38, 250.5)

        decoded = decode_pallet_db7(raw)
        self.assertEqual(-123, decoded["P1"]["source1"])
        self.assertEqual(456, decoded["P1"]["source2"])
        self.assertTrue(decoded["P1"]["running"])
        self.assertAlmostEqual(321.75, decoded["P1"]["quantity"])
        self.assertEqual(605, decoded["P3_P4"]["source"])
        self.assertEqual(5, decoded["P3_P4"]["selection"])
        self.assertAlmostEqual(250.5, decoded["P3_P4"]["quantity"])

    def test_non_finite_real_is_rejected(self):
        raw = bytearray(42)
        struct.pack_into(">f", raw, 10, float("nan"))
        with self.assertRaises(PalletPLCReadError):
            decode_pallet_db7(raw)


class PalletCollectorTests(unittest.TestCase):
    def test_plc_failure_rolls_back_and_survives(self):
        session = Mock()

        def failed_reader():
            raise PalletPLCReadError("offline")

        result = collect_pallet_history(failed_reader, session, use_advisory_lock=False)
        self.assertFalse(result["success"])
        self.assertEqual("plc", result["kind"])
        session.rollback.assert_called_once()

    def test_database_failure_rolls_back(self):
        session = Mock()
        session.commit.side_effect = RuntimeError("database offline")
        result = collect_pallet_history(
            lambda: pallet_data(p1=True),
            session,
            use_advisory_lock=False,
            model_factory=lambda **row: row,
        )
        self.assertFalse(result["success"])
        self.assertEqual("database", result["kind"])
        session.rollback.assert_called_once()


if __name__ == "__main__":
    unittest.main()
