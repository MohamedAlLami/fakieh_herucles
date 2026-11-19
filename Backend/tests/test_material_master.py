"""The material list follows the batch system's Materials.xml (UTF-16, <Material Name='..' Code='..' />)."""

import unittest

from services import material_master as mm

HEAD = "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\r\n<!-- Caution: schema is subject to change without notice -->\r\n\r\n<Materials >\r\n"
ROWS = [
    ("HY-Bond", "111"), ("PRODUCT1", "5000"), ("Salt", "202"), ("Empty", "0"), ("Maize", "100"),
    ("Wheat- Bran", "112"), ("SOYA", "105"), ("Soya Oil", "210"), ("Limestone", "113"),
    ("L&amp;STONE COARSE", "123"), ("BR-GR", "102030002"), ("Out Of Service", "999"), ("Not Used", "1"),
]


def xml(rows=ROWS, encoding="utf-16"):
    body = "".join("\t<Material Name='%s' Code='%s' />\r\n" % r for r in rows)
    return (HEAD + body + "</Materials>\r\n").encode(encoding)


class ParseTests(unittest.TestCase):
    def test_reads_the_utf16_file_in_file_order(self):
        got = mm.parse_materials_xml(xml())
        self.assertEqual(len(ROWS), len(got))
        self.assertEqual({"code": "111", "name": "HY-Bond"}, got[0])
        self.assertEqual({"code": "102030002", "name": "BR-GR"}, got[10])

    def test_xml_escapes_become_plain_text(self):
        names = {m["code"]: m["name"] for m in mm.parse_materials_xml(xml())}
        self.assertEqual("L&STONE COARSE", names["123"])

    def test_same_code_twice_keeps_one_row_with_the_later_name(self):
        got = mm.parse_materials_xml(xml(ROWS + [("Maize New", "100")]))
        self.assertEqual(len(ROWS), len(got))
        self.assertEqual("Maize New", {m["code"]: m["name"] for m in got}["100"])

    def test_rows_without_a_code_are_skipped(self):
        got = mm.parse_materials_xml(xml(ROWS + [("No code", "")]))
        self.assertEqual(len(ROWS), len(got))

    def test_half_written_file_is_refused(self):
        with self.assertRaises(mm.MaterialFileError):
            mm.parse_materials_xml(xml()[:200])

    def test_empty_file_is_refused(self):
        with self.assertRaises(mm.MaterialFileError):
            mm.parse_materials_xml(b"")

    def test_a_file_with_almost_nothing_in_it_is_refused(self):
        with self.assertRaises(mm.MaterialFileError):
            mm.parse_materials_xml(xml(ROWS[:3]))


def stored(rows, inactive=()):
    return {code: {"name": name.replace("&amp;", "&"), "active": code not in inactive} for name, code in rows}


class PlanTests(unittest.TestCase):
    def incoming(self, rows):
        return mm.parse_materials_xml(xml(rows))

    def test_same_file_changes_nothing(self):
        plan = mm.plan_sync(stored(ROWS), self.incoming(ROWS))
        self.assertEqual({"added": [], "reactivated": [], "renamed": [], "removed": []}, plan)

    def test_first_file_adds_everything(self):
        plan = mm.plan_sync({}, self.incoming(ROWS))
        self.assertEqual(len(ROWS), len(plan["added"]))
        self.assertEqual([], plan["removed"])

    def test_new_material_is_added(self):
        plan = mm.plan_sync(stored(ROWS), self.incoming(ROWS + [("Allzyme Vegpro", "159")]))
        self.assertEqual(["159"], plan["added"])

    def test_missing_material_is_removed_from_the_choices_not_deleted(self):
        plan = mm.plan_sync(stored(ROWS), self.incoming([r for r in ROWS if r[1] != "202"]))
        self.assertEqual(["202"], plan["removed"])

    def test_renamed_material(self):
        rows = [("Yellow Maize", c) if c == "100" else (n, c) for n, c in ROWS]
        self.assertEqual(["100"], mm.plan_sync(stored(ROWS), self.incoming(rows))["renamed"])

    def test_material_that_comes_back_is_reactivated(self):
        plan = mm.plan_sync(stored(ROWS, inactive={"202"}), self.incoming(ROWS))
        self.assertEqual(["202"], plan["reactivated"])

    def test_file_that_drops_most_of_the_list_is_refused(self):
        big = ROWS + [("X%d" % i, str(300 + i)) for i in range(30)]
        with self.assertRaises(mm.MaterialFileError):
            mm.plan_sync(stored(big), self.incoming(ROWS))


class FallbackTests(unittest.TestCase):
    def test_without_a_file_nothing_is_synced_and_nothing_breaks(self):
        report = mm.sync_from_file(path=r"C:\this\folder\does\not\exist\Materials.xml")
        self.assertEqual("no file", report.get("skipped"))
        self.assertFalse(report["changed"])

    def test_bad_file_reports_an_error_and_does_not_raise(self):
        import os
        import tempfile

        d = tempfile.mkdtemp()
        p = os.path.join(d, "Materials.xml")
        with open(p, "wb") as fh:
            fh.write(b"<Materials><Material Name='A' Code='1'/></Materials>")
        report = mm.sync_from_file(path=p)
        self.assertIn("only 1 materials", report.get("error", ""))
        self.assertFalse(report["changed"])


if __name__ == "__main__":
    unittest.main()
