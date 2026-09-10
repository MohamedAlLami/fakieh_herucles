import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from services.pallet_order_service import monitor_pallet_orders, process_monitor_data
from services.pallet_report_service import PalletPLCReadError


def plc_data(p1=False, p2=False, shared=False, selection=0, p1_source=101):
    return {
        "P1": {
            "source1": p1_source,
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


class FakeRepository:
    def __init__(self):
        self.active = {}
        self.sequences = {}
        self.orders = []
        self.started = []
        self.completed = []
        self.movement_counts = {}

    def get_active(self, line):
        return self.active.get(line)

    @staticmethod
    def routing(values):
        return tuple(values.get(key) for key in (
            "source1", "source2", "destination1", "destination2", "selection"
        ))

    def start(self, line, values, timestamp):
        sequence = self.sequences.get(line, 0) + 1
        self.sequences[line] = sequence
        order = SimpleNamespace(
            line=line,
            order_sequence=sequence,
            order_description=f"L{sequence}",
            status="RUNNING",
            latest_qty=values["quantity"],
            final_qty=None,
            routing=self.routing(values),
        )
        self.active[line] = order
        self.orders.append(order)
        self.started.append(line)
        self.movement_counts[line] = self.movement_counts.get(line, 0) + 1
        return order

    def update(self, order, values, timestamp):
        routing = self.routing(values)
        if routing != order.routing:
            self.movement_counts[order.line] += 1
            order.routing = routing
        order.latest_qty = values["quantity"]
        return order

    def complete(self, order, values, timestamp):
        order.latest_qty = values["quantity"]
        order.final_qty = values["quantity"]
        order.status = "COMPLETED"
        self.completed.append(order.line)
        self.active.pop(order.line, None)
        return order


class PalletOrderStateMachineTests(unittest.TestCase):
    def test_start_continue_complete_and_next_sequence(self):
        repo = FakeRepository()
        self.assertEqual("idle", process_monitor_data(plc_data(), repo)["P1"])
        self.assertEqual("started", process_monitor_data(plc_data(p1=True), repo)["P1"])
        self.assertEqual("L1", repo.active["P1"].order_description)
        self.assertEqual("continued", process_monitor_data(plc_data(p1=True), repo)["P1"])
        self.assertEqual(1, len([order for order in repo.orders if order.line == "P1"]))
        self.assertEqual("completed", process_monitor_data(plc_data(p1=False), repo)["P1"])
        self.assertEqual("started", process_monitor_data(plc_data(p1=True), repo)["P1"])
        self.assertEqual("L2", repo.active["P1"].order_description)

    def test_line_sequences_are_independent(self):
        repo = FakeRepository()
        process_monitor_data(plc_data(p1=True), repo)
        process_monitor_data(plc_data(), repo)
        process_monitor_data(plc_data(p1=True, p2=True), repo)
        self.assertEqual("L2", repo.active["P1"].order_description)
        self.assertEqual("L1", repo.active["P2"].order_description)

    def test_selection_3_to_5_continues_p3_and_starts_p4(self):
        repo = FakeRepository()
        process_monitor_data(plc_data(shared=True, selection=3), repo)
        p3_order = repo.active["P3"]
        actions = process_monitor_data(plc_data(shared=True, selection=5), repo)
        self.assertIs(p3_order, repo.active["P3"])
        self.assertEqual("continued", actions["P3"])
        self.assertEqual("started", actions["P4"])

    def test_selection_5_to_3_completes_only_p4(self):
        repo = FakeRepository()
        process_monitor_data(plc_data(shared=True, selection=5), repo)
        p3_order = repo.active["P3"]
        actions = process_monitor_data(plc_data(shared=True, selection=3), repo)
        self.assertIs(p3_order, repo.active["P3"])
        self.assertEqual("continued", actions["P3"])
        self.assertEqual("completed", actions["P4"])

    def test_selection_5_to_4_completes_only_p3(self):
        repo = FakeRepository()
        process_monitor_data(plc_data(shared=True, selection=5), repo)
        p4_order = repo.active["P4"]
        actions = process_monitor_data(plc_data(shared=True, selection=4), repo)
        self.assertIs(p4_order, repo.active["P4"])
        self.assertEqual("completed", actions["P3"])
        self.assertEqual("continued", actions["P4"])

    def test_selection_3_to_4_completes_p3_and_starts_p4(self):
        repo = FakeRepository()
        process_monitor_data(plc_data(shared=True, selection=3), repo)
        actions = process_monitor_data(plc_data(shared=True, selection=4), repo)
        self.assertEqual("completed", actions["P3"])
        self.assertEqual("started", actions["P4"])

    def test_shared_stop_completes_both_active_orders(self):
        repo = FakeRepository()
        process_monitor_data(plc_data(shared=True, selection=5), repo)
        actions = process_monitor_data(plc_data(shared=False, selection=5), repo)
        self.assertEqual("completed", actions["P3"])
        self.assertEqual("completed", actions["P4"])

    def test_existing_active_order_survives_server_restart(self):
        repo = FakeRepository()
        process_monitor_data(plc_data(p1=True), repo)
        existing = repo.active["P1"]
        repo.started.clear()  # Simulate a fresh monitor process using persisted state.
        actions = process_monitor_data(plc_data(p1=True), repo)
        self.assertEqual("continued", actions["P1"])
        self.assertIs(existing, repo.active["P1"])
        self.assertEqual([], repo.started)

    def test_movement_created_only_when_routing_changes(self):
        repo = FakeRepository()
        process_monitor_data(plc_data(p1=True), repo)
        process_monitor_data(plc_data(p1=True), repo)
        self.assertEqual(1, repo.movement_counts["P1"])
        process_monitor_data(plc_data(p1=True, p1_source=999), repo)
        self.assertEqual(2, repo.movement_counts["P1"])


class PalletOrderMonitorFailureTests(unittest.TestCase):
    def test_plc_failure_rolls_back_and_monitor_survives(self):
        session = Mock()

        def failed_reader():
            raise PalletPLCReadError("offline")

        result = monitor_pallet_orders(
            reader=failed_reader,
            session=session,
            repository=FakeRepository(),
            use_advisory_lock=False,
        )
        self.assertFalse(result["success"])
        self.assertEqual("plc", result["kind"])
        session.rollback.assert_called_once()

    def test_database_failure_rolls_back_and_monitor_survives(self):
        session = Mock()
        session.commit.side_effect = RuntimeError("database offline")
        result = monitor_pallet_orders(
            reader=lambda: plc_data(p1=True),
            session=session,
            repository=FakeRepository(),
            use_advisory_lock=False,
        )
        self.assertFalse(result["success"])
        self.assertEqual("database", result["kind"])
        session.rollback.assert_called_once()


if __name__ == "__main__":
    unittest.main()
