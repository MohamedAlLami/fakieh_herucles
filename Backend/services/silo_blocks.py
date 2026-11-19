"""Silo quantities read from (and, for the weighbridge, written to) the plant's own silo blocks.

Why this exists
---------------
The PLC keeps one 80-byte data block per silo. That block is what SCADA shows as BIN QUANTITY.
The hand-off block DB5 that Hercules used to rely on is only a partial copy: on site it carries
the 100 group and silo 201 and is zero for the 300, 600, 800 and 900 groups.

Layout of a silo block (measured on site 2026-11-11, identical for every group):
    length            80 bytes
    INT   at byte 16  silo number (101, 314, 841 ...)
    REAL  at byte 66  upper limit (kg)
    REAL  at byte 70  lower limit (kg, zero or negative)
    REAL  at byte 74  quantity (kg)

Block numbers are assigned by the PLC engineering tool and can change when the PLC program is
recompiled, so nothing here trusts a block number on its own: every read and every write first
checks that the block still carries the expected silo number. The silo -> block map is found by
scanning (about a minute, read-only) and cached in a JSON file.

Everything talks to the PLC through small callables so the logic is unit-testable without one.
"""
from __future__ import annotations

import json
import math
import os
import struct
import threading
import time
from typing import Callable, Dict, Iterable, List, Optional, Tuple

BLOCK_LEN = 80
OFF_SILO = 16
OFF_UPPER = 66
OFF_LOWER = 70
OFF_QTY = 74

SCAN_FIRST_DB = 2001
SCAN_LAST_DB = 12000
QTY_CACHE_SECONDS = 10.0
REDISCOVER_MIN_INTERVAL = 900.0
READBACK_TOLERANCE_KG = 0.01

Read80 = Callable[[int], Optional[bytes]]      # db_no -> first 80 bytes; None = no such block
IsLonger = Callable[[int], bool]               # db_no -> True when byte 80 is readable


class PlcUnavailable(RuntimeError):
    """The PLC could not be asked at all (link down, timeout).

    Read80 / IsLonger raise this instead of returning None, because "I could not ask" must never
    be mistaken for "the PLC says this block does not exist".
    """


def parse_block(data: Optional[bytes]) -> Optional[dict]:
    """Decode a silo block. None when the bytes cannot be a silo block."""
    if data is None or len(data) < BLOCK_LEN:
        return None
    silo = struct.unpack(">h", data[OFF_SILO:OFF_SILO + 2])[0]
    upper = struct.unpack(">f", data[OFF_UPPER:OFF_UPPER + 4])[0]
    lower = struct.unpack(">f", data[OFF_LOWER:OFF_LOWER + 4])[0]
    qty = struct.unpack(">f", data[OFF_QTY:OFF_QTY + 4])[0]
    if not (100 <= silo <= 999):
        return None
    if not all(math.isfinite(v) for v in (upper, lower, qty)):
        return None
    # A real silo block has a positive upper limit and a lower limit at or below zero.
    if not (upper >= 100.0 and lower <= 0.0):
        return None
    return {"silo_no": int(silo), "upper_kg": upper, "lower_kg": lower, "quantity_kg": qty}


def _patient(fn, db: int, tries: int, pause: float):
    """Call fn(db), riding out a brief link hiccup. Raises PlcUnavailable only if it persists."""
    for attempt in range(tries):
        try:
            return fn(db)
        except PlcUnavailable:
            if attempt == tries - 1:
                raise
            time.sleep(pause)


def discover(read80: Read80, is_longer: IsLonger, known_silos: Iterable[int],
             first_db: int = SCAN_FIRST_DB, last_db: int = SCAN_LAST_DB,
             should_stop: Optional[Callable[[], bool]] = None,
             tries: int = 4, pause: float = 0.5) -> dict:
    """Scan the PLC for silo blocks.

    Returns {"map": {silo: db}, "ambiguous": {silo: [db, ...]}, "complete": bool, "scanned": n}.
    A silo that matches more than one block is left OUT of the map: guessing is worse than unknown.
    """
    known = set(int(s) for s in known_silos)
    found: Dict[int, List[int]] = {}
    scanned = 0
    complete = True
    for db in range(int(first_db), int(last_db) + 1):
        if should_stop is not None and should_stop():
            complete = False
            break
        try:
            data = _patient(read80, db, tries, pause)
            if data is None:
                continue
            scanned += 1
            blk = parse_block(data)
            if blk is None or blk["silo_no"] not in known:
                continue
            if _patient(is_longer, db, tries, pause):   # same header, longer block: another kind
                continue
        except PlcUnavailable:
            complete = False       # the link dropped mid-scan: what we have is only part of the picture
            break
        found.setdefault(blk["silo_no"], []).append(db)
    mapping = {s: dbs[0] for s, dbs in found.items() if len(dbs) == 1}
    ambiguous = {s: dbs for s, dbs in found.items() if len(dbs) > 1}
    return {"map": mapping, "ambiguous": ambiguous, "complete": complete, "scanned": scanned}


def read_quantities(read80: Read80, mapping: Dict[int, int]) -> Tuple[Dict[int, float], List[int]]:
    """Read every mapped silo. Returns ({silo: kg}, [silos whose block no longer matches]).

    When the PLC cannot be reached (read80 raises PlcUnavailable) the silo is simply absent from
    the result: that says nothing about the map, so it is not reported as stale. Stale means the
    PLC answered and the block is gone, carries another silo number, or is not a silo block.
    """
    out: Dict[int, float] = {}
    stale: List[int] = []
    for silo, db in mapping.items():
        try:
            data = read80(db)
        except PlcUnavailable:
            break                  # link is down: stop asking, report what was read so far
        if data is None:
            stale.append(int(silo))    # the PLC answered: that block is gone
            continue
        blk = parse_block(data)
        if blk is None or blk["silo_no"] != int(silo):
            stale.append(int(silo))
            continue
        out[int(silo)] = round(float(blk["quantity_kg"]), 3)
    return out, stale


class SiloBlockError(RuntimeError):
    """Why a silo's block could not be used; the text is shown to the operator as the note."""


def read_one_checked(read80: Read80, mapping: Dict[int, int], silo_no: int,
                     tries: int = 4, pause: float = 0.5) -> float:
    """Fresh quantity of one silo. Raises SiloBlockError saying which of the three things went wrong."""
    db = mapping.get(int(silo_no))
    if db is None:
        raise SiloBlockError("silo has no known PLC block")
    try:
        data = _patient(read80, db, tries, pause)     # a stock update is worth a second of patience
    except PlcUnavailable:
        raise SiloBlockError("PLC not reachable")
    blk = parse_block(data)
    if blk is None or blk["silo_no"] != int(silo_no):
        raise SiloBlockError(f"PLC block DB{db} no longer belongs to silo {int(silo_no)}")
    return float(blk["quantity_kg"])


def read_one(read80: Read80, mapping: Dict[int, int], silo_no: int) -> Optional[float]:
    """Fresh quantity of one silo, or None when its block is unknown or no longer matches."""
    db = mapping.get(int(silo_no))
    if db is None:
        return None
    try:
        blk = parse_block(read80(db))
    except PlcUnavailable:
        return None
    if blk is None or blk["silo_no"] != int(silo_no):
        return None
    return float(blk["quantity_kg"])


SETTLE_SECONDS = 2.0


def write_one(read80: Read80, write_real: Callable[[int, int, float], None],
              mapping: Dict[int, int], silo_no: int, new_kg: float,
              settle_seconds: float = SETTLE_SECONDS, sleep: Callable[[float], None] = time.sleep) -> None:
    """Write a silo's quantity. Raises unless the block is verified before and confirmed after.

    write_real(db_no, byte_offset, value) writes one big-endian REAL.

    Confirmation is done twice: straight after the write, and again after settle_seconds (many PLC
    cycles later). If the PLC program were to put the old value back, the second look catches it
    and the write is reported as not confirmed instead of being believed.
    """
    silo_no = int(silo_no)
    db = mapping.get(silo_no)
    if db is None:
        raise LookupError(f"silo {silo_no} has no known PLC block")
    blk = parse_block(_patient(read80, db, 4, 0.5))
    if blk is None or blk["silo_no"] != silo_no:
        raise RuntimeError(f"DB{db} no longer carries silo {silo_no}; refusing to write")
    if not math.isfinite(float(new_kg)):
        raise ValueError("quantity is not a finite number")
    old_kg = float(blk["quantity_kg"])
    write_real(db, OFF_QTY, float(new_kg))
    back = parse_block(_patient(read80, db, 4, 0.5))
    if back is None or back["silo_no"] != silo_no:
        raise RuntimeError(f"DB{db} could not be read back after the write")
    tol = max(READBACK_TOLERANCE_KG, abs(float(new_kg)) * 1e-6)
    if abs(back["quantity_kg"] - float(new_kg)) >= tol:
        raise RuntimeError(f"PLC holds {back['quantity_kg']:.3f} kg after writing {float(new_kg):.3f} kg")
    if settle_seconds > 0 and abs(old_kg - float(new_kg)) >= tol:
        sleep(settle_seconds)
        later = parse_block(_patient(read80, db, 4, 0.5))
        if later is None or later["silo_no"] != silo_no:
            raise RuntimeError(f"DB{db} could not be read back {settle_seconds:.0f} s after the write")
        # The plant may legitimately dose a little out of the silo meanwhile, so the value may have
        # moved on. What must NOT happen is the old value coming back.
        if abs(later["quantity_kg"] - old_kg) < tol:
            raise RuntimeError(
                f"the PLC put the old quantity back ({old_kg:.3f} kg) {settle_seconds:.0f} s after "
                f"{float(new_kg):.3f} kg was written; the PLC program overrides this value")


# ---------------------------------------------------------------------------------------------
# Map file
# ---------------------------------------------------------------------------------------------

def map_file_path() -> str:
    override = os.getenv("SILO_BLOCK_MAP_FILE", "").strip()
    if override:
        return override
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "silo_block_map.json")


def load_map(path: Optional[str] = None) -> Dict[int, int]:
    path = path or map_file_path()
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
        return {int(k): int(v) for k, v in (raw.get("map") or {}).items()}
    except Exception:
        return {}


def load_suspects(path: Optional[str] = None) -> Dict[int, int]:
    """Silos set aside because their block stopped matching; they are re-checked on every refresh."""
    path = path or map_file_path()
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
        return {int(k): int(v) for k, v in (raw.get("set_aside") or {}).items()}
    except Exception:
        return {}


def save_map(mapping: Dict[int, int], path: Optional[str] = None, note: str = "",
             suspects: Optional[Dict[int, int]] = None) -> None:
    path = path or map_file_path()
    payload = {
        "note": note or "silo number -> PLC data block; rebuilt automatically by a read-only scan",
        "saved_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "map": {str(k): int(v) for k, v in sorted(mapping.items())},
        "set_aside": {str(k): int(v) for k, v in sorted((suspects or {}).items())},
    }
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=1)
    os.replace(tmp, path)


# ---------------------------------------------------------------------------------------------
# Live service used by the routes (holds the map, a short cache and the background rescan)
# ---------------------------------------------------------------------------------------------

def enabled() -> bool:
    return os.getenv("SILO_QTY_FROM_BLOCKS", "true").strip().lower() == "true"


class SiloBlockService:
    def __init__(self, read80: Read80, is_longer: IsLonger, known_silos: Callable[[], Iterable[int]],
                 path: Optional[str] = None):
        self._read80 = read80
        self._is_longer = is_longer
        self._known_silos = known_silos
        self._path = path
        self._lock = threading.Lock()
        self._map: Dict[int, int] = load_map(path)
        self._cache: Dict[int, float] = {}
        self._cache_at = 0.0
        self._last_scan = 0.0
        self._scanning = False
        # silo -> block it used to live in. Checked again on every refresh, so a silo whose block
        # reappears (a PLC download that was rolled back, a transient glitch) comes straight back.
        self._suspects: Dict[int, int] = {k: v for k, v in load_suspects(path).items() if k not in self._map}
        self._scan_range = (SCAN_FIRST_DB, SCAN_LAST_DB)

    def mapping(self) -> Dict[int, int]:
        with self._lock:
            return dict(self._map)

    def quantities(self) -> Dict[int, float]:
        """Cached quantities of every mapped silo ({} when nothing is mapped yet)."""
        with self._lock:
            if self._cache and time.time() - self._cache_at < QTY_CACHE_SECONDS:
                return dict(self._cache)
            mapping = dict(self._map)
        if not mapping:
            self._maybe_rescan("no silo block map yet")
            return {}
        qty, stale = read_quantities(self._read80, mapping)
        with self._lock:
            suspects = dict(self._suspects)
        if suspects:
            back, _still = read_quantities(self._read80, suspects)
            if back:
                qty.update(back)
                with self._lock:
                    for s in back:
                        self._map[s] = self._suspects.pop(s)
                print(f"[SILO-BLOCKS] {len(back)} silo block(s) match again: {sorted(back)[:8]}")
                self._save()
        with self._lock:
            if qty or stale:      # nothing read at all (PLC down): do not cache an empty answer
                self._cache, self._cache_at = dict(qty), time.time()
        if stale:
            with self._lock:
                for s in stale:
                    db = self._map.pop(s, None)
                    if db is not None:
                        self._suspects[s] = db
            self._save()
            self._maybe_rescan(f"{len(stale)} silo block(s) no longer match: {stale[:8]}")
        return qty

    def _save(self) -> None:
        try:
            with self._lock:
                mapping, suspects = dict(self._map), dict(self._suspects)
            save_map(mapping, self._path, suspects=suspects)
        except Exception as e:
            print(f"[SILO-BLOCKS] could not save the map file: {e}")

    def read_fresh(self, silo_no: int) -> Optional[float]:
        return read_one(self._read80, self.mapping(), silo_no)

    def read_fresh_checked(self, silo_no: int) -> float:
        """Like read_fresh but raises SiloBlockError with the reason."""
        return read_one_checked(self._read80, self.mapping(), silo_no)

    def invalidate(self) -> None:
        with self._lock:
            self._cache_at = 0.0

    def _maybe_rescan(self, reason: str) -> None:
        with self._lock:
            if self._scanning or time.time() - self._last_scan < REDISCOVER_MIN_INTERVAL:
                return
            self._scanning = True
            self._last_scan = time.time()
        print(f"[SILO-BLOCKS] rescanning the PLC for silo blocks ({reason})")
        threading.Thread(target=self._rescan, name="silo-block-scan", daemon=True).start()

    def _rescan(self) -> None:
        try:
            known = list(self._known_silos())
            res = discover(self._read80, self._is_longer, known,
                           first_db=self._scan_range[0], last_db=self._scan_range[1])
            if res["scanned"] == 0:
                print("[SILO-BLOCKS] scan read no blocks (PLC unreachable?); keeping the current map")
                return
            with self._lock:
                if res["complete"]:
                    # A full pass is the whole truth: it replaces the map.
                    self._map = dict(res["map"])
                    # A silo the scan could not place keeps its old address on the watch list:
                    # one cheap read per refresh, and it returns the moment that block is it again.
                    self._suspects = {k: v for k, v in self._suspects.items() if k not in self._map}
                else:
                    # The scan was cut short. It may ADD what it found; it must never remove
                    # a silo just because it did not get as far as that silo's block.
                    for silo, db in res["map"].items():
                        self._map[silo] = db
                        self._suspects.pop(silo, None)
                    self._last_scan = 0.0      # allow a fresh attempt soon
                self._cache_at = 0.0
                mapped = len(self._map)
            self._save()
            print(f"[SILO-BLOCKS] scan {'done' if res['complete'] else 'INTERRUPTED (kept the previous map, added what was found)'}: "
                  f"{mapped} silos mapped, {len(res['ambiguous'])} ambiguous, {res['scanned']} blocks read")
        except Exception as e:
            print(f"[SILO-BLOCKS] scan failed: {e}")
        finally:
            with self._lock:
                self._scanning = False
