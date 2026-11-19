"""The Fakieh "Dispatch and Receive Memo" (QMS F/TRN/04), filled from one weighbridge trip.

One place builds the page, so what is printed and what is saved as a PDF are the same thing:
  build_memo_html(trip)  -> the A4 page as HTML (the browser prints this)
  html_to_pdf(html)      -> the same page as PDF bytes, made by a browser that is already
                            installed on the machine (Chrome or Edge, run without a window)

Nothing here touches the PLC or the database.
"""
from __future__ import annotations

import html as _html
import logging
import os
import shutil
import subprocess
import tempfile
import threading
import time
from datetime import datetime
from typing import Any, Dict, List, Mapping, Optional

from services.dispatch_memo_logo import FAKIEH_WORDMARK

logger = logging.getLogger(__name__)


class MemoPdfError(RuntimeError):
    """The PDF could not be made on this machine. The message is safe to show."""


# ---------------------------------------------------------------- values

def _local(ts: Any) -> Optional[datetime]:
    if not ts:
        return None
    try:
        value = ts if isinstance(ts, datetime) else datetime.fromisoformat(str(ts))
    except (TypeError, ValueError):
        return None
    try:
        from utils.timezone import BUSINESS_TZ

        if value.tzinfo is not None:
            value = value.astimezone(BUSINESS_TZ)
    except Exception:
        pass
    return value


def _fmt_date(ts: Any) -> str:
    d = _local(ts)
    return d.strftime("%d/%m/%Y") if d else ""


def _fmt_clock(ts: Any) -> str:
    d = _local(ts)
    if not d:
        return ""
    hour = d.hour % 12 or 12
    return "%02d:%02d %s" % (hour, d.minute, "AM" if d.hour < 12 else "PM")


def _fmt_kg(kg: Any) -> str:
    if kg is None:
        return ""
    try:
        value = float(kg)
    except (TypeError, ValueError):
        return ""
    if value != value:
        return ""
    return "{:,.0f} kg".format(value)


def memo_values(trip: Mapping[str, Any]) -> Dict[str, str]:
    """The values that go on the paper. `trip` is a weighbridge trip as the API returns it."""
    product = " - ".join(str(x) for x in (trip.get("material_name"), trip.get("material_code")) if x)
    bags = trip.get("bags")
    return {
        "operationNo": str(trip.get("ticket") or ""),
        "date": _fmt_date(trip.get("second_ts") or trip.get("first_ts") or trip.get("created_at")),
        "clientName": str(trip.get("order_client_name") or ""),
        "product": product,
        "entryWeight": _fmt_kg(trip.get("first_weight_kg")),
        "exitWeight": _fmt_kg(trip.get("second_weight_kg")),
        "netWeight": _fmt_kg(trip.get("net_kg")),
        "bags": "" if bags is None else str(bags),
        "truckNo": str(trip.get("truck_plate") or ""),
        "carrier": str(trip.get("truck_company") or ""),
        "arrivalTime": _fmt_clock(trip.get("first_ts")),
        "departureTime": _fmt_clock(trip.get("second_ts")),
        "driverName": str(trip.get("driver_name") or trip.get("truck_driver") or ""),
        "scaleOperator": str(trip.get("exit_operator") or ""),
        "notes": str(trip.get("memo_notes") or ""),
    }


# ---------------------------------------------------------------- page

def _esc(value: Any) -> str:
    return _html.escape(str(value or ""), quote=True)


def _cell(en: str, ar: str, value: str, key: str) -> str:
    return (
        '<div class="cell"><div class="lbl"><span>%s</span><span class="ar">%s</span></div>'
        '<div class="val" data-memo="%s">%s</div></div>' % (en, ar, key, _esc(value) or "&nbsp;")
    )


def _section(en: str, ar: str, rows: List[str]) -> str:
    body = "\n".join('      <div class="row">%s</div>' % row for row in rows)
    return (
        '    <div class="box">\n      <div class="bar"><span>%s</span><span class="ar">%s</span></div>\n%s\n    </div>'
        % (en, ar, body)
    )


_STYLE = """
    @page { size: A4 portrait; margin: 12mm 13mm; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    html, body { margin: 0; padding: 0; background: #fff; color: #000; }
    body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; font-size: 11.5pt; }
    .sheet { min-height: 271mm; display: flex; flex-direction: column; }
    .ar { direction: rtl; unicode-bidi: isolate; font-family: "Segoe UI", Tahoma, Arial, sans-serif; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; }
    .pill { margin: 3mm 0 0 34mm; background: #000; color: #fff; border-radius: 9mm; padding: 2.6mm 9mm 3mm; text-align: center; font-weight: 700; line-height: 1.35; }
    .pill .ar { display: block; font-size: 13.5pt; }
    .pill .en { display: block; font-size: 11pt; }
    .brand { text-align: right; }
    .brand img { width: 37mm; display: block; margin-left: auto; }
    .qms { margin-top: 1.5mm; font-size: 7.5pt; font-weight: 700; line-height: 1.35; }
    .top { display: flex; margin: 9mm 0 3mm; font-weight: 700; }
    .top > div { flex: 1; display: flex; align-items: baseline; gap: 3mm; padding: 0 2mm; }
    .top .v { flex: 1; text-align: center; font-weight: 600; border-bottom: 0.3mm solid #999; min-height: 6mm; }
    .box { border: 0.5mm solid #000; margin-bottom: 4.5mm; }
    .bar { background: #d9d9d9; border-bottom: 0.5mm solid #000; display: flex; justify-content: space-between; padding: 1.6mm 2.2mm; font-weight: 700; font-size: 12pt; }
    .row { display: flex; }
    .row + .row { border-top: 0.5mm solid #000; }
    .cell { flex: 1; padding: 1.6mm 2.2mm 2mm; min-height: 15.5mm; }
    .cell + .cell { border-left: 0.5mm solid #000; }
    .lbl { display: flex; justify-content: space-between; font-weight: 700; font-size: 10.5pt; }
    .val { margin-top: 1.2mm; min-height: 6.5mm; border-bottom: 0.3mm solid #999; font-size: 12pt; font-weight: 600; text-align: center; unicode-bidi: plaintext; }
    .notes { margin-top: auto; }
    .notes .val { text-align: start; border-bottom: 0; min-height: 13mm; padding: 1.5mm 2.2mm; margin: 0; white-space: pre-wrap; font-weight: 500; }
    .foot { border-top: 0.4mm solid #000; margin-top: 5mm; padding-top: 1.5mm; text-align: center; font-size: 8pt; line-height: 1.5; }
    .foot .ar { display: block; }
"""


def build_memo_html(trip: Mapping[str, Any]) -> str:
    v = memo_values(trip)
    sections = "\n".join(
        [
            _section("Client &amp; Shipment", "بيانات العميل والشحنة", [
                _cell("Client Name", "اسم العميل", v["clientName"], "clientName"),
                _cell("Product", "المنتج", v["product"], "product"),
            ]),
            _section("Weights &amp; Quantities", "الأوزان والكميات", [
                _cell("Exit Weight", "وزن الخروج", v["exitWeight"], "exitWeight")
                + _cell("Entry Weight", "وزن الدخول", v["entryWeight"], "entryWeight"),
                _cell("No. of Bags", "عدد الأكياس", v["bags"], "bags")
                + _cell("Net Weight", "الوزن الصافي", v["netWeight"], "netWeight"),
            ]),
            _section("Transport Details", "بيانات النقل", [
                _cell("Carrier", "الناقل", v["carrier"], "carrier")
                + _cell("Truck No.", "رقم السيارة", v["truckNo"], "truckNo"),
                _cell("Departure Time", "ساعة المغادرة", v["departureTime"], "departureTime")
                + _cell("Arrival Time", "ساعة الوصول", v["arrivalTime"], "arrivalTime"),
                _cell("Signature", "التوقيع", "", "driverSignature")
                + _cell("Driver Name", "اسم السائق", v["driverName"], "driverName"),
                _cell("Signature", "التوقيع", "", "operatorSignature")
                + _cell("Scale Operator", "مشغل الميزان", v["scaleOperator"], "scaleOperator"),
            ]),
        ]
    )
    return """<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Dispatch and Receive Memo %(op)s</title>
  <style>%(style)s  </style>
</head>
<body>
  <div class="sheet">
    <div class="head">
      <div class="pill"><span class="ar">مذكرة إخراج واستلام</span><span class="en">Dispatch and Receive Memo</span></div>
      <div class="brand">
        <img src="%(logo)s" alt="Fakieh" />
        <div class="qms">QMS : F/TRN/04<br /><span class="ar">تاريخ الإصدار : ٢٠١٨/٦/٢٨م</span><br /><span class="ar">رقم الإصدار : ٣/١</span></div>
      </div>
    </div>

    <div class="top">
      <div><span>Operation No.</span><span class="v" data-memo="operationNo">%(op)s</span><span class="ar">رقم العملية</span></div>
      <div><span>Date</span><span class="v" data-memo="date">%(date)s</span><span class="ar">التاريخ</span></div>
    </div>
%(sections)s
    <div class="box notes">
      <div class="bar"><span>Notes</span><span class="ar">ملاحظات</span></div>
      <div class="val" data-memo="notes">%(notes)s</div>
    </div>
    <div class="foot">
      <div class="ar">جدة - حي المدينة الصناعية - المدخل الشمالي - ص.ب : ٨٧٦٣/٦٠٠٢ - الرمز البريدي : ٢١٤٩٢</div>
      <div class="ar">هاتف : ٠٠٩٦٦١٢٥٥٦٢٨٠٧/٠٠٩٦٦١٢٦٣٦٣٨٣٦ - س.ت : ٤٠٣٠١٦٩٦٠١ - <span dir="ltr">E.mail : feed@fakiehgroup.com</span></div>
    </div>
  </div>
</body>
</html>""" % {
        "op": _esc(v["operationNo"]),
        "date": _esc(v["date"]),
        "style": _STYLE,
        "logo": FAKIEH_WORDMARK,
        "sections": sections,
        "notes": _esc(v["notes"]) or "&nbsp;",
    }


def memo_file_name(trip: Mapping[str, Any]) -> str:
    ticket = "".join(ch for ch in str(trip.get("ticket") or "memo") if ch.isalnum() or ch in "-_")
    return "Dispatch-Memo-%s.pdf" % (ticket or "memo")


# ---------------------------------------------------------------- PDF

_BROWSER_CANDIDATES = [
    r"%ProgramFiles%\Google\Chrome\Application\chrome.exe",
    r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe",
    r"%LocalAppData%\Google\Chrome\Application\chrome.exe",
    r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe",
    r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe",
]
PDF_TIMEOUT_SECONDS = 45
_STATUS_CACHE_SECONDS = 600.0

_lock = threading.Lock()
_working_browser: Optional[str] = None
_status: Dict[str, Any] = {"checked_at": 0.0, "available": None, "browser": None, "error": None}


def browser_candidates() -> List[str]:
    """Browsers to try, the one that worked last first. MEMO_PDF_BROWSER overrides the list."""
    forced = os.environ.get("MEMO_PDF_BROWSER", "").strip()
    found: List[str] = [forced] if forced else []
    for raw in _BROWSER_CANDIDATES:
        path = os.path.expandvars(raw)
        if "%" not in path and os.path.isfile(path) and path not in found:
            found.append(path)
    if _working_browser in found:
        found.remove(_working_browser)
        found.insert(0, _working_browser)
    return found


def _run_browser(exe: str, html: str) -> bytes:
    folder = tempfile.mkdtemp(prefix="fakieh_memo_")
    try:
        page = os.path.join(folder, "memo.html")
        out = os.path.join(folder, "memo.pdf")
        with open(page, "w", encoding="utf-8") as fh:
            fh.write(html)
        args = [
            exe, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
            "--disable-extensions", "--no-pdf-header-footer",
            "--user-data-dir=" + os.path.join(folder, "profile"),
            "--print-to-pdf=" + out,
            "file:///" + page.replace("\\", "/"),
        ]
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        done = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True,
                              timeout=PDF_TIMEOUT_SECONDS, creationflags=flags)
        # Some builds return before the file is closed; give it a moment.
        for _ in range(20):
            if os.path.isfile(out) and os.path.getsize(out) > 0:
                break
            time.sleep(0.1)
        if not (os.path.isfile(out) and os.path.getsize(out) > 0):
            raise MemoPdfError("%s made no PDF (exit code %s)" % (os.path.basename(exe), done.returncode))
        with open(out, "rb") as fh:
            data = fh.read()
        if not data.startswith(b"%PDF"):
            raise MemoPdfError("%s wrote a file that is not a PDF" % os.path.basename(exe))
        return data
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def html_to_pdf(html: str) -> bytes:
    """The page as PDF bytes. Raises MemoPdfError when no installed browser can make it."""
    global _working_browser
    candidates = browser_candidates()
    if not candidates:
        raise MemoPdfError("No Chrome or Edge browser was found on the Hercules server")
    problems: List[str] = []
    with _lock:
        for exe in candidates:
            try:
                data = _run_browser(exe, html)
                _working_browser = exe
                return data
            except MemoPdfError as exc:
                problems.append(str(exc))
            except subprocess.TimeoutExpired:
                problems.append("%s did not finish in %s seconds" % (os.path.basename(exe), PDF_TIMEOUT_SECONDS))
            except Exception as exc:  # the browser could not even be started
                problems.append("%s: %s" % (os.path.basename(exe), exc))
    raise MemoPdfError("; ".join(problems))


def pdf_status(force: bool = False) -> Dict[str, Any]:
    """Can this machine make the PDF? Really makes a small one; the answer is kept for ten minutes."""
    now = time.time()
    if not force and _status["available"] is not None and now - _status["checked_at"] < _STATUS_CACHE_SECONDS:
        return dict(_status)
    try:
        html_to_pdf("<!DOCTYPE html><html><head><meta charset='utf-8'></head><body>Fakieh memo test</body></html>")
        _status.update(available=True, browser=os.path.basename(_working_browser or ""), error=None)
    except MemoPdfError as exc:
        _status.update(available=False, browser=None, error=str(exc))
    _status["checked_at"] = now
    return dict(_status)
