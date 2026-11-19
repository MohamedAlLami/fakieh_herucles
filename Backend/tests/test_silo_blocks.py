"""Silo block logic, tested against a fake PLC (a dict of data blocks). No snap7, no database."""
import os
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services import silo_blocks as sb  # noqa: E402



def block(silo, qty, upper=45000.0, lower=-5000.0, length=80, extra_ints=()):
    b = bytearray(length)
    struct.pack_into(">h", b, sb.OFF_SILO, silo)
    for off in extra_ints:
        struct.pack_into(">h", b, off, silo)
    struct.pack_into(">f", b, sb.OFF_UPPER, upper)
    struct.pack_into(">f", b, sb.OFF_LOWER, lower)
    struct.pack_into(">f", b, sb.OFF_QTY, qty)
    return b


class FakePlc:
    def __init__(self, blocks):
        self.blocks = blocks
        self.writes = []
        self.drop_writes = False

    def read80(self, db):
        b = self.blocks.get(db)
        return bytes(b[:80]) if b is not None and len(b) >= 80 else None

    def is_longer(self, db):
        b = self.blocks.get(db)
        return b is not None and len(b) > 80

    def write_real(self, db, off, value):
        self.writes.append((db, off, value))
        if not self.drop_writes:
            struct.pack_into(">f", self.blocks[db], off, value)


def site():
    """A cut-down copy of what was measured on site on 2026-11-11."""
    return FakePlc({
        4784: block(801, 45000.0, extra_ints=(8, 14)),
        3737: block(802, 45000.0, extra_ints=(8, 14)),
        6459: block(841, 20000.0, extra_ints=(8, 14)),
        6202: block(101, 1124479.25, upper=1e7, lower=-20000.0, extra_ints=(4,)),
        6232: block(314, -6005.438, upper=1e7, lower=-20000.0, extra_ints=(8, 10, 12, 14)),
        6217: block(201, -28.935, upper=1e6, lower=-20000.0),
        2500: bytearray(80),                                     # empty block
        2501: block(801, 7.0, length=200),                       # same header, different kind of block
        2502: block(555, 1.0),                                   # a number that is not one of our silos
        2503: block(802, 9.0, upper=0.0, lower=0.0),             # limits not plausible
        2504: bytearray(40),                                     # too short
    })


KNOWN = [101, 201, 314, 801, 802, 841, 848]


def plc_down(db):
    raise sb.PlcUnavailable("link down")


class ParseTests(unittest.TestCase):
    def test_reads_fields(self):
        blk = sb.parse_block(bytes(block(841, 20000.0)))
        self.assertEqual(blk["silo_no"], 841)
        self.assertEqual(blk["quantity_kg"], 20000.0)
        self.assertEqual((blk["upper_kg"], blk["lower_kg"]), (45000.0, -5000.0))

    def test_rejects_non_blocks(self):
        self.assertIsNone(sb.parse_block(None))
        self.assertIsNone(sb.parse_block(bytes(40)))
        self.assertIsNone(sb.parse_block(bytes(80)))
        self.assertIsNone(sb.parse_block(bytes(block(802, 9.0, upper=0.0, lower=0.0))))
        nan = block(801, 1.0)
        nan[sb.OFF_QTY:sb.OFF_QTY + 4] = b"\x7f\xc0\x00\x00"
        self.assertIsNone(sb.parse_block(bytes(nan)))


class DiscoverTests(unittest.TestCase):
    def test_finds_each_silo_once(self):
        plc = site()
        res = sb.discover(plc.read80, plc.is_longer, KNOWN, first_db=2001, last_db=7000)
        self.assertEqual(res["map"], {801: 4784, 802: 3737, 841: 6459, 101: 6202, 314: 6232, 201: 6217})
        self.assertEqual(res["ambiguous"], {})
        self.assertTrue(res["complete"])

    def test_duplicate_silo_is_left_out(self):
        plc = site()
        plc.blocks[5000] = block(841, 123.0)
        res = sb.discover(plc.read80, plc.is_longer, KNOWN, first_db=2001, last_db=7000)
        self.assertNotIn(841, res["map"])
        self.assertEqual(res["ambiguous"], {841: [5000, 6459]})

    def test_link_drop_mid_scan_is_incomplete_not_empty(self):
        plc = site()

        def flaky(db):
            if db > 5000:
                raise sb.PlcUnavailable("link dropped")
            return plc.read80(db)

        res = sb.discover(flaky, plc.is_longer, KNOWN, first_db=2001, last_db=7000, pause=0)
        self.assertFalse(res["complete"])
        self.assertEqual(res["map"], {801: 4784, 802: 3737})       # only what it reached

    def test_brief_hiccup_does_not_abort_the_scan(self):
        plc = site()
        seen = {}

        def hiccups(db):                     # every block fails once, then answers
            seen[db] = seen.get(db, 0) + 1
            if seen[db] == 1:
                raise sb.PlcUnavailable("blip")
            return plc.read80(db)

        res = sb.discover(hiccups, plc.is_longer, KNOWN, first_db=2001, last_db=7000, pause=0)
        self.assertTrue(res["complete"])
        self.assertEqual(len(res["map"]), 6)

    def test_stop_marks_incomplete(self):
        plc = site()
        res = sb.discover(plc.read80, plc.is_longer, KNOWN, first_db=2001, last_db=7000,
                          should_stop=lambda: True)
        self.assertFalse(res["complete"])


class ReadWriteTests(unittest.TestCase):
    def setUp(self):
        self.plc = site()
        self.map = {801: 4784, 841: 6459, 101: 6202, 314: 6232}

    def test_quantities_match_scada(self):
        qty, stale = sb.read_quantities(self.plc.read80, self.map)
        self.assertEqual(qty, {801: 45000.0, 841: 20000.0, 101: 1124479.25, 314: -6005.438})
        self.assertEqual(stale, [])

    def test_renumbered_block_is_reported_not_trusted(self):
        self.plc.blocks[6459] = block(840, 77.0)       # PLC recompiled: this block is another silo now
        qty, stale = sb.read_quantities(self.plc.read80, self.map)
        self.assertNotIn(841, qty)
        self.assertEqual(stale, [841])
        self.assertIsNone(sb.read_one(self.plc.read80, self.map, 841))

    def test_unreachable_plc_is_not_called_stale(self):
        qty, stale = sb.read_quantities(plc_down, self.map)
        self.assertEqual((qty, stale), ({}, []))

    def test_block_the_plc_says_is_gone_is_stale(self):
        del self.plc.blocks[6459]
        qty, stale = sb.read_quantities(self.plc.read80, self.map)
        self.assertNotIn(841, qty)
        self.assertEqual(stale, [841])

    def test_checked_read_names_the_reason(self):
        self.assertEqual(sb.read_one_checked(self.plc.read80, self.map, 841), 20000.0)
        with self.assertRaisesRegex(sb.SiloBlockError, "no known PLC block"):
            sb.read_one_checked(self.plc.read80, self.map, 999)
        with self.assertRaisesRegex(sb.SiloBlockError, "not reachable"):
            sb.read_one_checked(plc_down, self.map, 841, pause=0)
        self.plc.blocks[6459] = block(840, 77.0)
        with self.assertRaisesRegex(sb.SiloBlockError, "no longer belongs to silo 841"):
            sb.read_one_checked(self.plc.read80, self.map, 841)

    def test_write_lands_on_the_quantity_only(self):
        before = bytes(self.plc.blocks[6202])
        sb.write_one(self.plc.read80, self.plc.write_real, self.map, 101, 1152379.25, sleep=lambda s: None)
        after = bytes(self.plc.blocks[6202])
        self.assertEqual(self.plc.writes, [(6202, sb.OFF_QTY, 1152379.25)])
        self.assertEqual(after[:sb.OFF_QTY], before[:sb.OFF_QTY])
        self.assertEqual(after[sb.OFF_QTY + 4:], before[sb.OFF_QTY + 4:])
        self.assertEqual(sb.read_one(self.plc.read80, self.map, 101), 1152379.25)

    def test_write_refused_when_block_is_another_silo(self):
        self.plc.blocks[6202] = block(102, 10000.0, upper=1e9, lower=-20000.0)
        with self.assertRaises(RuntimeError):
            sb.write_one(self.plc.read80, self.plc.write_real, self.map, 101, 5.0, sleep=lambda s: None)
        self.assertEqual(self.plc.writes, [])

    def test_write_refused_for_unknown_silo_and_bad_number(self):
        with self.assertRaises(LookupError):
            sb.write_one(self.plc.read80, self.plc.write_real, self.map, 999, 5.0)
        with self.assertRaises(ValueError):
            sb.write_one(self.plc.read80, self.plc.write_real, self.map, 101, float("nan"))
        self.assertEqual(self.plc.writes, [])

    def test_value_the_plc_puts_back_is_caught(self):
        # A PLC program that overrides the quantity: the write lands, then the old value returns.
        def plc_program_restores(_seconds):
            struct.pack_into(">f", self.plc.blocks[6202], sb.OFF_QTY, 1124479.25)

        with self.assertRaisesRegex(RuntimeError, "put the old quantity back"):
            sb.write_one(self.plc.read80, self.plc.write_real, self.map, 101, 1152379.25,
                         sleep=plc_program_restores)

    def test_dosing_after_the_write_is_not_a_failure(self):
        def plant_doses_meanwhile(_seconds):
            struct.pack_into(">f", self.plc.blocks[6202], sb.OFF_QTY, 1152379.25 - 180.5)

        sb.write_one(self.plc.read80, self.plc.write_real, self.map, 101, 1152379.25,
                     sleep=plant_doses_meanwhile)        # no exception

    def test_unconfirmed_write_raises(self):
        self.plc.drop_writes = True
        with self.assertRaises(RuntimeError):
            sb.write_one(self.plc.read80, self.plc.write_real, self.map, 101, 5.0, sleep=lambda s: None)


class ServiceTests(unittest.TestCase):
    def test_map_file_round_trip_and_stale_drop(self):
        plc = site()
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "map.json")
            sb.save_map({801: 4784, 841: 6459}, path)
            self.assertEqual(sb.load_map(path), {801: 4784, 841: 6459})
            svc = sb.SiloBlockService(plc.read80, plc.is_longer, lambda: KNOWN, path)
            svc._last_scan = 1e18                      # no background scan in this test
            self.assertEqual(svc.quantities(), {801: 45000.0, 841: 20000.0})
            plc.blocks[6459] = block(840, 77.0)
            svc.invalidate()
            self.assertEqual(svc.quantities(), {801: 45000.0})
            self.assertNotIn(841, svc.mapping())

    def test_plc_outage_keeps_the_map(self):
        plc = site()
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "map.json")
            sb.save_map({801: 4784, 841: 6459}, path)
            alive = {"up": True}
            svc = sb.SiloBlockService(lambda db: plc.read80(db) if alive["up"] else plc_down(db),
                                      plc.is_longer, lambda: KNOWN, path)
            svc._last_scan = 1e18
            self.assertEqual(svc.quantities(), {801: 45000.0, 841: 20000.0})
            alive["up"] = False
            svc.invalidate()
            self.assertEqual(svc.quantities(), {})
            self.assertEqual(svc.mapping(), {801: 4784, 841: 6459})   # nothing dropped
            alive["up"] = True
            self.assertEqual(svc.quantities(), {801: 45000.0, 841: 20000.0})   # back at once

    def test_interrupted_rescan_never_shrinks_the_map(self):
        plc = site()
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "map.json")
            full = {801: 4784, 802: 3737, 841: 6459, 101: 6202, 314: 6232, 201: 6217}
            sb.save_map(full, path)

            def flaky(db):                       # the link dies part-way through the scan
                if db > 5000:
                    raise sb.PlcUnavailable("link dropped")
                return plc.read80(db)

            svc = sb.SiloBlockService(flaky, plc.is_longer, lambda: KNOWN, path)
            svc._rescan()
            self.assertEqual(svc.mapping(), full)                 # nothing lost
            self.assertEqual(sb.load_map(path), full)             # and nothing lost on disk

    def test_complete_rescan_replaces_the_map(self):
        plc = site()
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "map.json")
            sb.save_map({801: 9999, 555: 2502}, path)             # an out-of-date map
            svc = sb.SiloBlockService(plc.read80, plc.is_longer, lambda: KNOWN, path)
            svc._scan_range = (2001, 7000)
            svc._rescan()
            self.assertEqual(svc.mapping(),
                             {801: 4784, 802: 3737, 841: 6459, 101: 6202, 314: 6232, 201: 6217})

    def test_silo_whose_block_matches_again_comes_back_by_itself(self):
        plc = site()
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "map.json")
            sb.save_map({801: 4784, 841: 6459}, path)
            svc = sb.SiloBlockService(plc.read80, plc.is_longer, lambda: KNOWN, path)
            svc._last_scan = 1e18                                 # no background scan here
            good = bytes(plc.blocks[6459])
            plc.blocks[6459] = block(840, 77.0)
            self.assertEqual(svc.quantities(), {801: 45000.0})
            plc.blocks[6459] = bytearray(good)                    # the block is silo 841 again
            svc.invalidate()
            self.assertEqual(svc.quantities(), {801: 45000.0, 841: 20000.0})
            self.assertEqual(svc.mapping(), {801: 4784, 841: 6459})

    def test_set_aside_silo_survives_a_restart_and_comes_back(self):
        plc = site()
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "map.json")
            sb.save_map({801: 4784, 841: 6459}, path)
            svc = sb.SiloBlockService(plc.read80, plc.is_longer, lambda: KNOWN, path)
            svc._last_scan = 1e18
            good = bytes(plc.blocks[6459])
            plc.blocks[6459] = block(840, 77.0)
            svc.quantities()                                      # 841 is set aside and saved
            self.assertEqual(sb.load_map(path), {801: 4784})
            self.assertEqual(sb.load_suspects(path), {841: 6459})
            plc.blocks[6459] = bytearray(good)
            svc2 = sb.SiloBlockService(plc.read80, plc.is_longer, lambda: KNOWN, path)   # "restart"
            svc2._last_scan = 1e18
            self.assertEqual(svc2.quantities(), {801: 45000.0, 841: 20000.0})
            self.assertEqual(sb.load_map(path), {801: 4784, 841: 6459})

    def test_missing_map_file_is_empty(self):
        self.assertEqual(sb.load_map(os.path.join(tempfile.gettempdir(), "no-such-map-xyz.json")), {})


if __name__ == "__main__":
    unittest.main()
