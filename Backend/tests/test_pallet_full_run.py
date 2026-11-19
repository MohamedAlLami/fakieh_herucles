"""Full run (FullRun bit, order start to end) versus actual run (Running bit) on the pallet lines."""

import struct
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from services import pallet_report_service as prs
from services.pallet_order_service import (
    accumulate_active_seconds,
    effective_line_values,
    process_monitor_data,
)
from tests.test_pallet_order_service import FakeRepository

BASE = datetime(2026, 11, 12, 8, 0, tzinfo=timezone.utc)


def data(p1=False, p1_full=None, shared=False, selection=0, p3_full=None, p4_full=None):
    return {
        "P1": {"source1": 101, "source2": 102, "destination1": 201, "destination2": 202,
               "quantity": 500.0, "running": p1, "full_run": p1_full},
        "P2": {"source1": 301, "source2": 302, "destination1": 401, "destination2": 402,
               "quantity": 600.0, "running": False, "full_run": None if p1_full is None else False},
        "P3_P4": {"source": 605, "destination1": 701, "destination2": 702, "quantity": 250.0,
                  "running": shared, "selection": selection,
                  "full_run_p3": p3_full, "full_run_p4": p4_full},
    }


class DecoderTests(unittest.TestCase):
    def test_44_byte_db_gives_the_four_full_run_bits(self):
        raw = bytearray(44)
        raw[42] = 0b00001010  # P2 and P4
        decoded = prs.decode_pallet_db7(raw)
        self.assertIs(False, decoded["P1"]["full_run"])
        self.assertIs(True, decoded["P2"]["full_run"])
        self.assertIs(False, decoded["P3_P4"]["full_run_p3"])
        self.assertIs(True, decoded["P3_P4"]["full_run_p4"])

    def test_each_bit_maps_to_its_own_line(self):
        for line, bit in (("P1", 0), ("P2", 1), ("P3", 2), ("P4", 3)):
            raw = bytearray(44)
            raw[42] = 1 << bit
            decoded = prs.decode_pallet_db7(raw)
            got = {name: prs.line_full_run(decoded, name) for name in ("P1", "P2", "P3", "P4")}
            self.assertEqual({name: name == line for name in got}, got)

    def test_old_42_byte_db_still_decodes_and_reports_unknown(self):
        raw = bytearray(42)
        raw[8] = 1
        struct.pack_into(">f", raw, 10, 12.5)
        decoded = prs.decode_pallet_db7(raw)
        self.assertTrue(decoded["P1"]["running"])
        for line in ("P1", "P2", "P3", "P4"):
            self.assertIsNone(prs.line_full_run(decoded, line))


class ReadFallbackTests(unittest.TestCase):
    def setUp(self):
        prs._full_layout_retry_at = 0.0
        prs._full_layout_seen = False
        prs._full_layout_failures = 0

    tearDown = setUp

    def test_new_plc_is_read_with_44_bytes(self):
        calls = []

        def reader(db, size):
            calls.append(size)
            return bytearray(size)

        self.assertEqual(44, len(prs._read_db7_raw(reader)))
        self.assertEqual(44, len(prs._read_db7_raw(reader)))
        self.assertEqual([44, 44], calls)

    def test_old_plc_falls_back_to_42_and_does_not_retry_every_cycle(self):
        calls = []

        def reader(db, size):
            calls.append(size)
            return None if size > 42 else bytearray(42)

        self.assertEqual(42, len(prs._read_db7_raw(reader)))
        self.assertEqual(42, len(prs._read_db7_raw(reader)))
        self.assertEqual([44, 42, 44, 42], calls)

    def test_short_answer_to_the_long_read_is_not_used(self):
        def reader(db, size):
            return bytearray(32) if size > 42 else bytearray(42)

        self.assertEqual(42, len(prs._read_db7_raw(reader)))

    def test_one_failed_read_on_a_new_plc_is_not_mistaken_for_an_old_plc(self):
        answers = [None]  # the first 44-byte read fails once

        def reader(db, size):
            if size > 42 and answers:
                return answers.pop()
            return bytearray(size)

        self.assertEqual(44, len(prs._read_db7_raw(reader)))
        self.assertTrue(prs._full_layout_seen)

    def test_after_the_bits_were_seen_a_failed_read_is_a_failure_not_a_fallback(self):
        state = {"down": False}
        calls = []

        def reader(db, size):
            calls.append(size)
            if state["down"] and size > 42:
                return None
            return bytearray(size)

        self.assertEqual(44, len(prs._read_db7_raw(reader)))
        state["down"] = True
        self.assertIsNone(prs._read_db7_raw(reader))
        self.assertEqual([44, 44], calls)  # never asked for the old 42 bytes
        state["down"] = False
        self.assertEqual(44, len(prs._read_db7_raw(reader)))

    def test_plc_offline_teaches_nothing(self):
        self.assertIsNone(prs._read_db7_raw(lambda db, size: None))
        self.assertEqual(0.0, prs._full_layout_retry_at)
        self.assertFalse(prs._full_layout_seen)


class SnapshotTests(unittest.TestCase):
    def lines(self, **kw):
        return [(r["line"], r["running"], r["full_run"]) for r in prs.build_snapshot_rows(data(**kw), BASE)]

    def test_paused_order_is_still_stored_but_not_as_running(self):
        self.assertEqual([("P1", False, True)], self.lines(p1=False, p1_full=True))

    def test_running_order(self):
        self.assertEqual([("P1", True, True)], self.lines(p1=True, p1_full=True))

    def test_nothing_stored_when_both_bits_are_off(self):
        self.assertEqual([], self.lines(p1=False, p1_full=False))

    def test_without_full_run_bits_only_running_lines_are_stored(self):
        self.assertEqual([("P1", True, None)], self.lines(p1=True))
        self.assertEqual([], self.lines(p1=False))

    def test_p3_paused_while_p4_runs_on_the_shared_bit(self):
        rows = self.lines(shared=True, selection=4, p3_full=True, p4_full=True)
        self.assertEqual([("P3", False, True), ("P4", True, True)], rows)


def snap(row_id, minute, running=True, full_run=True, line="P1"):
    at = BASE + timedelta(minutes=minute)
    return SimpleNamespace(id=row_id, line=line, source1=602, source2=0, destination1=848,
                           destination2=0, quantity=1000.0 + row_id, selection=None,
                           running=running, full_run=full_run, recorded_at=at, created_at=at)


class HistorySessionTests(unittest.TestCase):
    def test_two_hour_order_with_a_thirty_minute_pause(self):
        rows = [snap(i + 1, i, running=not (45 <= i < 75)) for i in range(120)]
        (session,) = prs.build_history_sessions(rows, now=BASE + timedelta(hours=5))
        self.assertEqual("COMPLETED", session["status"])
        self.assertEqual(120 * 60, session["full_run_seconds"])
        self.assertEqual(90 * 60, session["actual_run_seconds"])
        self.assertEqual(session["full_run_seconds"], session["duration_seconds"])

    def test_pause_does_not_split_the_order(self):
        rows = [snap(i + 1, i, running=i not in (3, 4, 5, 6, 7)) for i in range(12)]
        sessions = prs.build_history_sessions(rows, now=BASE + timedelta(hours=5))
        self.assertEqual(1, len(sessions))

    def test_never_paused_order_has_equal_runs(self):
        rows = [snap(i + 1, i) for i in range(10)]
        (session,) = prs.build_history_sessions(rows, now=BASE + timedelta(hours=5))
        self.assertEqual(session["full_run_seconds"], session["actual_run_seconds"])

    def test_rows_from_before_the_feature_count_as_running(self):
        rows = []
        for i in range(10):
            row = snap(i + 1, i)
            del row.running, row.full_run
            rows.append(row)
        (session,) = prs.build_history_sessions(rows, now=BASE + timedelta(hours=5))
        self.assertEqual(600, session["full_run_seconds"])
        self.assertEqual(600, session["actual_run_seconds"])

    def test_live_order_that_is_paused_now(self):
        rows = [snap(1, 0), snap(2, 1), snap(3, 2, running=False), snap(4, 3, running=False)]
        (session,) = prs.build_history_sessions(rows, now=BASE + timedelta(minutes=3, seconds=30))
        self.assertEqual("RUNNING", session["status"])
        self.assertTrue(session["paused"])
        self.assertEqual(210, session["full_run_seconds"])
        self.assertEqual(120, session["actual_run_seconds"])


class StateMachineTests(unittest.TestCase):
    def test_pause_inside_a_full_run_keeps_one_order(self):
        repo = FakeRepository()
        self.assertEqual("started", process_monitor_data(data(p1=True, p1_full=True), repo)["P1"])
        order = repo.active["P1"]
        self.assertEqual("continued", process_monitor_data(data(p1=False, p1_full=True), repo)["P1"])
        self.assertEqual("continued", process_monitor_data(data(p1=True, p1_full=True), repo)["P1"])
        self.assertIs(order, repo.active["P1"])
        self.assertEqual("completed", process_monitor_data(data(p1=False, p1_full=False), repo)["P1"])
        self.assertEqual(1, len(repo.orders))

    def test_full_run_alone_opens_the_order(self):
        repo = FakeRepository()
        self.assertEqual("started", process_monitor_data(data(p1=False, p1_full=True), repo)["P1"])

    def test_without_full_run_bits_a_stop_still_completes(self):
        repo = FakeRepository()
        process_monitor_data(data(p1=True), repo)
        self.assertEqual("completed", process_monitor_data(data(p1=False), repo)["P1"])

    def test_p3_and_p4_use_their_own_full_run_bits(self):
        values = effective_line_values(data(shared=True, selection=3, p3_full=True, p4_full=False))
        self.assertEqual((True, True), (values["P3"]["running"], values["P3"]["full_run"]))
        self.assertEqual((False, False), (values["P4"]["running"], values["P4"]["full_run"]))


class ActiveSecondsTests(unittest.TestCase):
    def test_running_time_is_added_and_paused_time_is_not(self):
        t = BASE
        total = 0.0
        total = accumulate_active_seconds(total, True, t, t + timedelta(seconds=2), True)
        self.assertEqual(2.0, total)
        total = accumulate_active_seconds(total, True, t + timedelta(seconds=2), t + timedelta(seconds=4), False)
        self.assertEqual(4.0, total)
        total = accumulate_active_seconds(total, False, t + timedelta(seconds=4), t + timedelta(minutes=30), True)
        self.assertEqual(4.0, total)

    def test_backend_downtime_counts_only_if_running_on_both_sides(self):
        t = BASE
        self.assertEqual(600.0, accumulate_active_seconds(0.0, True, t, t + timedelta(minutes=10), True))
        self.assertEqual(10.0, accumulate_active_seconds(0.0, True, t, t + timedelta(minutes=10), False))

    def test_order_from_before_the_feature_ran_the_whole_time(self):
        start = BASE
        now = BASE + timedelta(minutes=20)
        self.assertEqual(1200.0, accumulate_active_seconds(None, None, None, now, True, start))


if __name__ == "__main__":
    unittest.main()
