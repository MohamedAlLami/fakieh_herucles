"""Which PLC errors mean 'could not ask' and which mean 'the PLC said no'. Wordings seen in the field."""
import ast
import os
import unittest

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "routes", "plc_routes.py")


def _load():
    """Pull just the classifier out of plc_routes.py (importing the module needs Flask and a database)."""
    tree = ast.parse(open(SRC, encoding="utf-8").read())
    keep = [n for n in tree.body
            if (isinstance(n, ast.Assign) and getattr(n.targets[0], "id", "") == "_PLC_LINK_ERROR_WORDS")
            or (isinstance(n, ast.FunctionDef) and n.name == "_is_plc_link_error")]
    ns = {}
    exec(compile(ast.Module(body=keep, type_ignores=[]), SRC, "exec"), ns)
    return ns["_is_plc_link_error"]


is_link_error = _load()


class S7ProtocolError(Exception):
    pass


class S7ConnectionError(Exception):
    pass


class LinkErrorTests(unittest.TestCase):
    def test_plc_answers_are_not_link_errors(self):
        for text in ("b'CPU : Item not available'", "b'CPU : Address out of range'",
                     "Read operation failed: Object does not exist (0x0a)",
                     "Read operation failed: Invalid address (0x05)"):
            self.assertFalse(is_link_error(S7ProtocolError(text)), text)
            self.assertFalse(is_link_error(RuntimeError(text)), text)

    def test_link_failures_are_link_errors(self):
        self.assertTrue(is_link_error(S7ConnectionError("anything")))
        self.assertTrue(is_link_error(ConnectionResetError("x")))
        self.assertTrue(is_link_error(TimeoutError()))
        for text in ("TCP connection failed: [WinError 10061] No connection could be made",
                     "b' ISO : An error occurred during recv TCP : Connection timed out'",
                     "Socket not initialized", "Not connected", "b' TCP : Unreachable peer'",
                     "Stale packet"):
            self.assertTrue(is_link_error(RuntimeError(text)), text)


if __name__ == "__main__":
    unittest.main()
