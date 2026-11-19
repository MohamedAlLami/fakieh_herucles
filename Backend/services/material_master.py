"""The plant's material list, kept in step with the batch system's Materials.xml.

The batch PC (Os1) owns the list: \\\\Os1\\batch\\EDS\\Materials.xml. The Hercules backend service
cannot open that share itself, so a small Windows task copies the file to a local folder every
couple of minutes and this module reads the local copy.

Rules:
- a material in the file is active and can be chosen;
- a material that disappears from the file is kept but marked inactive: it can no longer be
  chosen, and old trips, orders and silos still show its name;
- a file that cannot be read, or that would wipe out most of the list, is ignored and the last
  good list stays in use;
- with no file at all, the built-in list (constants.material_codes) is used, exactly as before.

Nothing here talks to the PLC.
"""
from __future__ import annotations

import logging
import os
import threading
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

DEFAULT_XML_PATH = r"C:\ProgramData\FakiehHercules\Materials.xml"
HEARTBEAT_NAME = "last_copy.txt"      # touched by the copy task each time it reaches Os1
MIN_MATERIALS = 10                    # fewer than this is not a real material list
MAX_DROP_FRACTION = 0.5               # a file that removes more than half the list is refused
CACHE_SECONDS = 30

_DDL = [
    """CREATE TABLE IF NOT EXISTS public.material_master (
           code VARCHAR(50) PRIMARY KEY,
           name VARCHAR(200) NOT NULL DEFAULT '',
           active BOOLEAN NOT NULL DEFAULT TRUE,
           position INTEGER NOT NULL DEFAULT 0,
           first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )""",
]

_lock = threading.Lock()
_ensured = False
_cache: Optional[Dict[str, object]] = None
_cache_at = 0.0
_last_file_key = None
_status: Dict[str, object] = {
    "source": "built-in list",
    "file": None,
    "file_changed_at": None,
    "last_copy_at": None,
    "synced_at": None,
    "count": None,
    "error": None,
}


class MaterialFileError(ValueError):
    """The file is not a usable material list; the message is safe to show."""


def xml_path() -> str:
    return os.getenv("MATERIALS_XML_PATH") or DEFAULT_XML_PATH


def parse_materials_xml(raw: bytes) -> List[Dict[str, str]]:
    """[{code, name}] in file order. Raises MaterialFileError if it is not a material list."""
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        raise MaterialFileError(f"not valid XML: {exc}") from exc
    out: List[Dict[str, str]] = []
    seen: Dict[str, int] = {}
    for el in root.iter("Material"):
        code = (el.get("Code") or "").strip()
        name = (el.get("Name") or "").strip()
        if not code:
            continue
        if code in seen:                       # the same code twice: the later line wins
            out[seen[code]]["name"] = name
            continue
        seen[code] = len(out)
        out.append({"code": code, "name": name})
    if len(out) < MIN_MATERIALS:
        raise MaterialFileError(f"only {len(out)} materials found; expected at least {MIN_MATERIALS}")
    return out


def plan_sync(current: Dict[str, Dict[str, object]], incoming: List[Dict[str, str]]) -> Dict[str, list]:
    """What a new file changes, given the stored rows {code: {name, active}}. Pure."""
    new_codes = {m["code"] for m in incoming}
    active_now = {c for c, r in current.items() if r.get("active")}
    added = [m["code"] for m in incoming if m["code"] not in current]
    reactivated = [m["code"] for m in incoming if m["code"] in current and not current[m["code"]].get("active")]
    renamed = [m["code"] for m in incoming
               if m["code"] in current and (current[m["code"]].get("name") or "") != m["name"]]
    removed = sorted(active_now - new_codes)
    if active_now and len(removed) > len(active_now) * MAX_DROP_FRACTION:
        raise MaterialFileError(
            f"the file would remove {len(removed)} of {len(active_now)} materials; it was ignored")
    return {"added": added, "reactivated": reactivated, "renamed": renamed, "removed": removed}


def _engine():
    from routes import plc_routes
    return plc_routes._engine_app()


def ensure_tables(engine=None) -> None:
    global _ensured
    if _ensured:
        return
    with _lock:
        if _ensured:
            return
        engine = engine or _engine()
        with engine.begin() as conn:
            for stmt in _DDL:
                conn.exec_driver_sql(stmt)
        _ensured = True


def _load_rows(conn) -> Dict[str, Dict[str, object]]:
    rows = conn.exec_driver_sql(
        "SELECT code, name, active, position FROM public.material_master ORDER BY position, code"
    ).fetchall()
    return {r[0]: {"name": r[1] or "", "active": bool(r[2]), "position": int(r[3] or 0)} for r in rows}


def _iso(ts: Optional[float]) -> Optional[str]:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat() if ts else None


def sync_from_file(path: Optional[str] = None, force: bool = False, engine=None) -> Dict[str, object]:
    """Read the local copy of Materials.xml and bring the stored list in step with it.

    Returns a small report. Never raises: a bad or missing file leaves the last good list in use.
    """
    global _last_file_key, _cache
    path = path or xml_path()
    report: Dict[str, object] = {"file": path, "changed": False}
    hb = os.path.join(os.path.dirname(path), HEARTBEAT_NAME)
    try:
        _status["last_copy_at"] = _iso(os.path.getmtime(hb)) if os.path.exists(hb) else None
    except OSError:
        pass
    try:
        if not os.path.exists(path):
            _status.update(file=path, error=None)
            if _status.get("synced_at") is None:
                _status["source"] = "built-in list"
            report["skipped"] = "no file"
            return report
        st = os.stat(path)
        key = (st.st_mtime, st.st_size)
        if not force and key == _last_file_key:
            report["skipped"] = "unchanged"
            return report
        with open(path, "rb") as fh:
            incoming = parse_materials_xml(fh.read())
        engine = engine or _engine()
        ensure_tables(engine)
        with engine.begin() as conn:
            current = _load_rows(conn)
            plan = plan_sync(current, incoming)
            for pos, m in enumerate(incoming):
                conn.exec_driver_sql(
                    "INSERT INTO public.material_master (code, name, active, position) "
                    "VALUES (%(c)s, %(n)s, TRUE, %(p)s) "
                    "ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, active = TRUE, "
                    "position = EXCLUDED.position, last_seen = NOW(), "
                    "updated_at = CASE WHEN public.material_master.name <> EXCLUDED.name "
                    "OR NOT public.material_master.active THEN NOW() ELSE public.material_master.updated_at END",
                    {"c": m["code"], "n": m["name"], "p": pos},
                )
            if plan["removed"]:
                conn.exec_driver_sql(
                    "UPDATE public.material_master SET active = FALSE, updated_at = NOW() "
                    "WHERE code = ANY(%(codes)s) AND active",
                    {"codes": plan["removed"]},
                )
        _last_file_key = key
        with _lock:
            _cache = None
        _status.update(source="Os1 Materials.xml", file=path, file_changed_at=_iso(st.st_mtime),
                       synced_at=datetime.now(timezone.utc).isoformat(), count=len(incoming), error=None)
        report.update(changed=True, count=len(incoming), **plan)
        if any(plan.values()):
            logger.info("Material list updated from %s: %d materials, +%d new, %d renamed, %d removed, %d back",
                        path, len(incoming), len(plan["added"]), len(plan["renamed"]),
                        len(plan["removed"]), len(plan["reactivated"]))
        return report
    except MaterialFileError as exc:
        _status.update(file=path, error=str(exc))
        _last_file_key = None
        logger.warning("Materials.xml ignored: %s", exc)
        report["error"] = str(exc)
        return report
    except Exception as exc:  # database or disk trouble: keep serving the last good list
        _status.update(file=path, error=f"could not update the material list: {exc}")
        _last_file_key = None
        logger.error("Material list sync failed: %s", exc, exc_info=True)
        report["error"] = str(exc)
        return report


def _builtin() -> Dict[str, object]:
    from constants.material_codes import MATERIAL_CODES
    active = [dict(m) for m in MATERIAL_CODES]
    return {"active": active, "names": {m["code"]: m["name"] for m in active}, "inactive": [], "from_db": False}


def _snapshot() -> Dict[str, object]:
    """Active list, every known name, and the inactive ones. Cached briefly; never raises."""
    global _cache, _cache_at
    now = time.monotonic()
    with _lock:
        if _cache is not None and now - _cache_at < CACHE_SECONDS:
            return _cache
    snap = None
    try:
        engine = _engine()
        ensure_tables(engine)
        with engine.connect() as conn:
            rows = _load_rows(conn)
        if rows:
            snap = {
                "active": [{"code": c, "name": r["name"]} for c, r in rows.items() if r["active"]],
                "inactive": [{"code": c, "name": r["name"]} for c, r in rows.items() if not r["active"]],
                "names": {c: r["name"] for c, r in rows.items()},
                "from_db": True,
            }
    except Exception as exc:
        logger.debug("material list falls back to the built-in list: %s", exc)
    if snap is None:
        snap = _builtin()
    with _lock:
        _cache, _cache_at = snap, now
    return snap


def reset_cache() -> None:
    global _cache
    with _lock:
        _cache = None


def active_materials() -> List[Dict[str, str]]:
    return list(_snapshot()["active"])  # type: ignore[arg-type]


def inactive_materials() -> List[Dict[str, str]]:
    return list(_snapshot()["inactive"])  # type: ignore[arg-type]


def is_active(code: str) -> bool:
    code = str(code).strip()
    return any(m["code"] == code for m in _snapshot()["active"])  # type: ignore[union-attr]


def name_of(code: str) -> Optional[str]:
    """Name of an active or inactive material, or None if this list never had it."""
    return _snapshot()["names"].get(str(code).strip())  # type: ignore[union-attr]


def status() -> Dict[str, object]:
    out = dict(_status)
    snap = _snapshot()
    out["active_count"] = len(snap["active"])        # type: ignore[arg-type]
    out["inactive_count"] = len(snap["inactive"])    # type: ignore[arg-type]
    if not snap["from_db"]:
        out["source"] = "built-in list"
    elif out.get("synced_at") is None:
        out["source"] = "last saved list"
    return out
