

import os, re, json, struct, time, threading, copy
from typing import Dict, Any, List, Optional, Tuple
from datetime import datetime
from flask import Blueprint, jsonify, request, current_app
from models import db
from models.rfid import RFIDConfig
from models.weights import RFIDLog

# ─────────────────────────── Blueprints ───────────────────────────
plc_bp = Blueprint("plc", __name__, url_prefix="/api/plc")   # PLC + admin endpoints
api_bp = Blueprint("api", __name__, url_prefix="/api")       # Frontend-friendly endpoints

# ─────────────────────────── Config ────────────────────────────
DEFAULT_CONFIG: Dict[str, Any] = {
    "plc": {"ip": "192.168.0.100", "rack": 0, "slot": 3},
    "default_db": 1,
    "read_len_cap": 0,
    "demo_mode": False,
    "check_silos": True,
    "db_absent_cooldown_sec": 10,  # avoid hammering a missing DB
}

def _load_config() -> Dict[str, Any]:
    cfg = DEFAULT_CONFIG.copy()
    here = os.path.abspath(os.path.dirname(__file__))
    cfg_path = os.path.join(here, "..", "config.json")
    if os.path.exists(cfg_path):
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                user_cfg = json.load(f)

            def merge(a, b):
                for k, v in b.items():
                    if isinstance(v, dict) and isinstance(a.get(k), dict):
                        merge(a[k], v)
                    else:
                        a[k] = v

            merge(cfg, user_cfg)
            print(f"[CONF] Loaded {cfg_path}")
        except Exception as e:
            print(f"[CONF] Failed to read {cfg_path}: {e} (defaults used)")
    return cfg

CONF = _load_config()
PLC_IP   = os.getenv("PLC_IP",   str(CONF["plc"]["ip"]))
PLC_RACK = int(os.getenv("PLC_RACK", str(CONF["plc"]["rack"])))
PLC_SLOT = int(os.getenv("PLC_SLOT", str(CONF["plc"]["slot"])))
DEFAULT_DB = int(os.getenv("PLC_DB", str(CONF["default_db"])))
READ_LEN_CAP = int(os.getenv("READ_LEN", str(CONF["read_len_cap"])))
DEMO_MODE = os.getenv("DEMO_MODE", str(CONF["demo_mode"])).lower() == "true"
CHECK_SILOS = os.getenv("CHECK_SILOS", str(CONF["check_silos"])).lower() == "true"
DB_ABSENT_COOLDOWN = int(os.getenv("DB_ABSENT_COOLDOWN_SEC", str(CONF["db_absent_cooldown_sec"])))

# ─────────────────────────── snap7 ─────────────────────────────
try:
    import snap7
    from snap7.util import get_int, get_bool, get_real
    _snap7_loaded = True
except Exception as e:
    snap7 = None
    _snap7_loaded = False
    print(f"[WARN] python-snap7 not available ({e}).")

# ─────────────────────── DB engines / helpers ───────────────────
def _engine_plc():
    """Engine used for the PLC mapping tables (bind='plc' if configured)."""
    try:
        return db.get_engine(bind="plc")
    except Exception:
        return db.get_engine()

def _pg_rows(sql: str, params: dict = None):
    engine = _engine_plc()
    with engine.connect() as conn:
        return conn.exec_driver_sql(sql, params or {}).fetchall()

def _engine_app():
    """Default app engine for silo_status & silo_status_history."""
    return db.get_engine()

def _app_exec(sql: str, params: dict = None):
    engine = _engine_app()
    with engine.begin() as conn:
        conn.exec_driver_sql(sql, params or {})

def _app_rows(sql: str, params: dict = None):
    engine = _engine_app()
    with engine.connect() as conn:
        return conn.exec_driver_sql(sql, params or {}).fetchall()

# ────────────────────────── Mapping ────────────────────────────
def _norm_type(t: Optional[str]) -> str:
    if not t: return ""
    t = re.sub(r"\s+", "", t.upper())
    if t in ("DINT", "WORD", "UINT", "DWORD"): return "INT"
    if t in ("FLOAT", "LREAL"):                return "REAL"
    return t

def load_map_from_pg(db_no: int) -> Dict[str, Any]:
    # Use hardcoded mapping for DB3 to avoid database connection issues
    if db_no == 3:
        print(f"[DB] Using hardcoded mapping for DB{db_no}")
        return {
            "line_tags": [
                ("L3_BadgeNo", "INT", 0, None),
                ("L3_SourceRawMaterialCode", "STRING[16]", 2, 16),  # Fixed: STRING[16] not STRING[20]
                ("L3_DeclaredQuantity_KG", "REAL", 20, None),      # Fixed: offset 20 not 22
                ("L3_DestinationSilo1", "INT", 24, None),          # Fixed: offset 24 not 26
                ("L3_DestinationSilo2", "INT", 26, None),          # Fixed: offset 26 not 28
                ("L3_StatusWord", "INT", 454, None),               # Status word at offset 454.0
            ],
            "silo_meta": {
                # Mineral silos 401-408 - CORRECT offsets from DB3 PLC mapping table
                401: {"code": (28, 16), "name": (46, 32)},   # MatCode S401, MatName S401
                402: {"code": (80, 16), "name": (98, 32)},   # MatCode S402, MatName S402
                403: {"code": (132, 16), "name": (150, 32)}, # MatCode S403, MatName S403
                404: {"code": (184, 16), "name": (202, 32)}, # MatCode S404, MatName S404
                405: {"code": (236, 16), "name": (254, 32)}, # MatCode S405, MatName S405
                406: {"code": (288, 16), "name": (306, 32)}, # MatCode S406, MatName S406
                407: {"code": (340, 16), "name": (358, 32)}, # MatCode S407, MatName S407
                408: {"code": (392, 16), "name": (410, 32)}, # MatCode S408, MatName S408
            },
            "hl_map": {
                # High level and lock bits for mineral silos - CORRECT offsets from DB3 PLC mapping table
                401: {"hl": (444, 0), "lock": (444, 1)},     # HL S401, LOCK S401
                402: {"hl": (444, 2), "lock": (444, 3)},     # HL S402, LOCK S402
                403: {"hl": (444, 4), "lock": (444, 5)},     # HL S403, LOCK S403
                404: {"hl": (444, 6), "lock": (444, 7)},     # HL S404, LOCK S404
                405: {"hl": (445, 0), "lock": (445, 1)},     # HL S405, LOCK S405
                406: {"hl": (445, 2), "lock": (445, 3)},     # HL S406, LOCK S406
                407: {"hl": (445, 4), "lock": (445, 5)},     # HL S407, LOCK S407
                408: {"hl": (445, 6), "lock": (445, 7)},     # HL S408, LOCK S408
            },
            "max_byte": 460  # Updated: Last field is at offset 454 (INT = 2 bytes) + 6 = 460
        }
    
    # Use hardcoded mapping for DB2 800 series silos and outloading lines
    if db_no == 2:
        print(f"[DB] Using hardcoded mapping for DB{db_no} (800 series silos + outloading lines)")
        return {
            "line_tags": [
                # Outloading Line 1 tags - Based on actual PLC addresses
                # Read-only status tags
                ("L1_RFID_BadgeReading", "REAL", 2598, None),
                ("L1_ActiveBadge", "INT", 2602, None),
                ("L1_ActiveDestination", "INT", 2604, None),
                ("L1_StatusWord", "INT", 2606, None),
                ("L1_ACTIVE_DEST_SEL", "INT", 2608, None),
                
                # Write tags for order creation - CORRECT addresses from PLC mapping
                ("L1_BadgeNo", "INT", 0, None),
                ("L1_SourceRawMaterialCode", "STRING[16]", 2, 16),
                ("L1_DEST_SEL", "INT", 20, None),
                ("L1_DeclaredQuantity_KG", "REAL", 22, None),
                ("L1_DestinationSilo1", "INT", 26, None),
                ("L1_DestinationSilo2", "INT", 28, None),
                
                # Outloading Line 2 tags - Based on actual PLC addresses
                # Read-only status tags
                ("L2_RFID_BadgeReading", "REAL", 2610, None),
                ("L2_ActiveBadge", "INT", 2614, None),
                ("L2_ActiveDestination", "INT", 2616, None),
                ("L2_StatusWord", "INT", 2618, None),
                ("L2_ACTIVE_DEST_SEL", "INT", 2620, None),
                
                # Write tags for order creation - CORRECT addresses from PLC mapping
                ("L2_BadgeNo", "INT", 30, None),
                ("L2_SourceRawMaterialCode", "STRING[16]", 32, 16),
                ("L2_DEST_SEL", "INT", 50, None),
                ("L2_DeclaredQuantity_KG", "REAL", 52, None),
                ("L2_DestinationSilo1", "INT", 56, None),
                ("L2_DestinationSilo2", "INT", 58, None),
                
                # Outloading Line 3 tags - Based on actual PLC addresses
                # Read-only status tags
                ("L3_RFID_BadgeReading", "REAL", 2622, None),
                ("L3_ActiveBadge", "INT", 2626, None),
                ("L3_ActiveDestination", "INT", 2628, None),
                ("L3_StatusWord", "INT", 2630, None),
                ("L3_ACTIVE_DEST_SEL", "INT", 2632, None),
                
                # Write tags for order creation - CORRECT addresses from PLC mapping
                ("L3_BadgeNo", "INT", 60, None),
                ("L3_SourceRawMaterialCode", "STRING[16]", 62, 16),
                ("L3_DEST_SEL", "INT", 80, None),
                ("L3_DeclaredQuantity_KG", "REAL", 82, None),
                ("L3_DestinationSilo1", "INT", 86, None),
                ("L3_DestinationSilo2", "INT", 88, None),
            ],
            "silo_meta": {
                # 800 series silos material data - based on PLC addressing table
                # Each silo takes 52 bytes (16 for code + 32 for name + 4 padding)
                **{silo_no: {
                    "code": (90 + (silo_no - 801) * 52, 16), 
                    "name": (90 + (silo_no - 801) * 52 + 18, 32)
                } for silo_no in range(801, 849)}
            },
            "hl_map": {
                # 800 series silos status bits - based on PLC addressing table
                # HL_S801 at offset 2586.0, LOCK_S801 at offset 2586.1
                # Each silo uses 2 bits (1 for HL, 1 for LOCK)
                **{silo_no: {
                    "hl": (2586 + ((silo_no - 801) * 2) // 8, ((silo_no - 801) * 2) % 8),
                    "lock": (2586 + ((silo_no - 801) * 2) // 8, ((silo_no - 801) * 2) % 8 + 1)
                } for silo_no in range(801, 849)}
            },
            "max_byte": 2640  # Updated: Last field is at offset 2632 (L3_ACTIVE_DEST_SEL) + 8 = 2640
        }
    
    # For other databases, try the database connection
    table = f"db{db_no}_map"
    sql = f'''SELECT tag_name, tag_type, byte_offset, bit_index, str_len, silo_no, category
              FROM "{table}"'''
    try:
        rows = _pg_rows(sql)
    except Exception as e:
        print(f"[DB] load_map_from_pg error: {e}")
        return {"line_tags": [], "silo_meta": {}, "hl_map": {}, "max_byte": 0}

    line_tags: List[Tuple[str, str, int, Optional[int]]] = []
    silo_meta: Dict[int, Dict[str, Tuple[int, int]]] = {}
    hl_map: Dict[int, Dict[str, Tuple[int, int]]] = {}
    max_byte = 0

    for name, t, byte_off, bit_idx, str_len, silo_no, category in rows:
        t_norm = _norm_type(t)
        off = int(byte_off or 0)
        span = off + (4 if t_norm == "REAL" else 2 if t_norm == "INT"
                      else (2 + int(str_len or 32)) if t_norm.startswith("STRING[") else 1)
        max_byte = max(max_byte, span)

        if category == "line":
            line_tags.append((name, t_norm, off, int(str_len) if str_len else None))
        elif category == "silo_code" and silo_no is not None:
            silo_meta.setdefault(int(silo_no), {})["code"] = (off, int(str_len or 16))
        elif category == "silo_name" and silo_no is not None:
            silo_meta.setdefault(int(silo_no), {})["name"] = (off, int(str_len or 32))
        elif category == "hl" and silo_no is not None and bit_idx is not None:
            hl_map.setdefault(int(silo_no), {})["hl"] = (off, int(bit_idx))
        elif category == "lock" and silo_no is not None and bit_idx is not None:
            hl_map.setdefault(int(silo_no), {})["lock"] = (off, int(bit_idx))

    return {"line_tags": line_tags, "silo_meta": silo_meta, "hl_map": hl_map, "max_byte": max_byte}

def _find_tag(m: Dict[str, Any], tag_name: str) -> Optional[Tuple[str, int, str, Optional[int]]]:
    for n, t, off, slen in m.get("line_tags", []):
        if n == tag_name:
            return (n, off, t, slen)
    return None

# ─────────────────────── S7 string helper ──────────────────────
def s7_get_string(buf: bytearray, byte_offset: int, max_len_hint: Optional[int] = None) -> str:
    try:
        if byte_offset + 2 > len(buf): return ""
        max_len = buf[byte_offset]; act_len = buf[byte_offset + 1]
        if max_len_hint is not None: max_len = min(max_len, max_len_hint)
        act_len = min(act_len, max_len)
        raw = bytes(buf[byte_offset+2 : byte_offset+2+act_len])
        try:
            return raw.decode("latin-1").rstrip("\x00")
        except Exception:
            return raw.decode("utf-8", errors="ignore").rstrip("\x00")
    except Exception:
        return ""

# ───────────────────── snap7 client + caches ───────────────────
CLIENT = None
CLIENT_LOCK = threading.Lock()

# per-DB cache: last good length, or absent cooldown
_DB_CACHE: Dict[int, Dict[str, Any]] = {}  # {db: {"good_len": int|None, "absent_until": ts or 0}}

def ensure_client():
    global CLIENT
    if not _snap7_loaded:
        return None
    
    try:
        if CLIENT is None:
            CLIENT = snap7.client.Client()
            CLIENT.connect(PLC_IP, PLC_RACK, PLC_SLOT)
            print(f"[PLC] Connected to {PLC_IP}:{PLC_RACK}:{PLC_SLOT}")
        elif not CLIENT.get_connected():
            # Disconnect first to clean up any stale connection
            try:
                CLIENT.disconnect()
            except:
                pass
            CLIENT.connect(PLC_IP, PLC_RACK, PLC_SLOT)
            print(f"[PLC] Reconnected to {PLC_IP}:{PLC_RACK}:{PLC_SLOT}")
        return CLIENT
    except Exception as e:
        print(f"[PLC] Connection error: {e}")
        # Reset client to force reconnection on next attempt
        CLIENT = None
        return None

def check_plc_health():
    """Check if PLC connection is healthy"""
    global CLIENT
    
    if not _snap7_loaded:
        return False
    
    try:
        cli = ensure_client()
        if cli is None:
            return False
        
        # Try a simple read to test connection
        with CLIENT_LOCK:
            cli.db_read(1, 0, 2)  # Try to read 2 bytes from DB1
        return True
    except Exception as e:
        print(f"[PLC] Health check failed: {e}")
        CLIENT = None
        return False

def _set_absent(db_no: int):
    _DB_CACHE.setdefault(db_no, {})
    _DB_CACHE[db_no]["absent_until"] = time.time() + DB_ABSENT_COOLDOWN
    _DB_CACHE[db_no]["good_len"] = None

def _absent_now(db_no: int) -> bool:
    ent = _DB_CACHE.get(db_no) or {}
    ts = ent.get("absent_until") or 0
    return time.time() < ts

def _remember_good(db_no: int, ln: int):
    _DB_CACHE.setdefault(db_no, {})
    _DB_CACHE[db_no]["good_len"] = ln
    _DB_CACHE[db_no]["absent_until"] = 0

def _last_good_len(db_no: int) -> Optional[int]:
    ent = _DB_CACHE.get(db_no) or {}
    return ent.get("good_len")

def _needed_bytes(m: Dict[str, Any]) -> int:
    max_byte = int(m.get("max_byte", 0))
    # For small databases, don't add extra buffer to avoid out-of-range errors
    if max_byte <= 100:
        return max(32, max_byte)
    else:
        return max(32, max_byte + 8)

def _sizes_to_try(first: int) -> List[int]:
    # probe upwards then downwards-friendly set
    # Extended sizes to handle larger databases with status words at high offsets
    sizes = [2, 16, 32, 48, 64, 80, 96, 128, 160, 192, 256, 384, 512, 768, 1024, 
             1280, 1536, 1792, 2048, 2304, 2560, 2816, 3072, 3328, 3584, 3840, 4096,
             4352, 4608, 4864, 5120, 5376, 5632, 5888, 6144, 6400, 6656, 6912, 7168, 7424, 7680]
    if first in sizes:
        i = sizes.index(first)
        return sizes[i:] + sizes[:i]
    return sizes

def read_db_bytes(db_no: int, required_len: int) -> Optional[bytearray]:
    """Probe actual DB length; cache good length; cool-down when absent."""
    global CLIENT
    
    if DEMO_MODE:
        return bytearray(max(2, required_len))

    if not _snap7_loaded:
        return None

    if _absent_now(db_no):
        return None

    cli = ensure_client()
    if cli is None:
        return None

    # clamp requirement
    if READ_LEN_CAP and required_len > READ_LEN_CAP:
        required_len = READ_LEN_CAP

    # For status word reading, try direct read first to bypass cache issues
    if required_len > 64:  # Try direct read for any size larger than basic cache
        try:
            with CLIENT_LOCK:
                data = cli.db_read(db_no, 0, required_len)
            _remember_good(db_no, required_len)
            return bytearray(data)
        except Exception as e:
            error_msg = str(e).lower()
            if "out of range" in error_msg:
                # Try smaller sizes
                pass
            elif "connection reset" in error_msg or "tcp" in error_msg:
                print(f"[PLC] TCP connection error for DB{db_no}: {e}")
                CLIENT = None
                _set_absent(db_no)
                return None
            else:
                print(f"[PLC] Read error for DB{db_no}: {e}")
                # Continue to fallback method

    # try cache first
    cached = _last_good_len(db_no)
    if cached and cached >= required_len:
        try_order = [cached] + [s for s in (cached+32, cached+64, cached+128) if s > cached]
    else:
        # Prefer sizes >= required_len so DB5 qty reads don't stop at 64 bytes
        all_sizes = _sizes_to_try(max(64, min(required_len, 512)))
        at_least = sorted(s for s in all_sizes if s >= required_len)
        below = sorted((s for s in all_sizes if s < required_len), reverse=True)
        try_order = at_least + below

    # Always ensure we try the required length first
    if required_len not in try_order:
        try_order.insert(0, required_len)

    best: Optional[bytearray] = None
    best_len = 0
    for ln in try_order:
        if best_len >= required_len:
            break
        try:
            with CLIENT_LOCK:
                data = cli.db_read(db_no, 0, max(2, ln))
            buf = bytearray(data)
            if len(buf) > best_len:
                best = buf
                best_len = len(buf)
                _remember_good(db_no, ln)
        except Exception as e:
            error_msg = str(e).lower()
            if "out of range" in error_msg:
                continue
            elif "connection reset" in error_msg or "tcp" in error_msg:
                print(f"[PLC] TCP connection error for DB{db_no}: {e}")
                CLIENT = None
                _set_absent(db_no)
                return None
            else:
                print(f"[PLC] Read error for DB{db_no}: {e}")
            return None

    if best is not None:
        return best

    # mark absent if even 2 bytes fail
    try:
        with CLIENT_LOCK:
            cli.db_read(db_no, 0, 2)
    except Exception as e:
        error_msg = str(e).lower()
        if "connection reset" in error_msg or "tcp" in error_msg:
            print(f"[PLC] TCP connection error for DB{db_no}: {e}")
            CLIENT = None
        _set_absent(db_no)
        return None
    return None

ALLOW_FORCE_WRITES = os.getenv("ALLOW_FORCE_WRITES", "true").lower() == "true"

def _force_enabled(req) -> bool:
    if not ALLOW_FORCE_WRITES:
        return False
    j = {}
    try:
        j = req.get_json(silent=True) or {}
    except Exception:
        pass
    # allow via JSON body, query param, or header
    val = (
        str(j.get("force", "")).lower()
        or str(req.args.get("force", "")).lower()
        or str(req.headers.get("X-Force-Write", "")).lower()
    )
    return val in ("1", "true", "yes")

# ─────────────────────────── Decoders ───────────────────────────
def render_lines(b: bytearray, line_tags: List[Tuple[str, str, int, Optional[int]]]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    L = len(b)
    for name, t, byte, strlen in line_tags:
        T = _norm_type(t)
        need = 2 if T.startswith("STRING[") else 4 if T=="REAL" else 2 if T=="INT" else 1 if T=="BOOL" else 0
        if need == 0 or byte + (need - 1) >= L:
            out[name] = None; continue
        try:
            if T == "BOOL":   out[name] = bool(get_bool(b, byte, 0))
            elif T == "REAL": out[name] = round(get_real(b, byte), 3)
            elif T == "INT":  out[name] = get_int(b, byte)
            else:             out[name] = s7_get_string(b, byte, int(strlen or 32))
        except Exception:
            out[name] = None
    return out

def render_silos(b: bytearray, silo_meta: Dict[int, Dict[str, Tuple[int, int]]], hl_map: Dict[int, Dict[str, Tuple[int, int]]]):
    rows = []
    L = len(b)
    all_silos = set(silo_meta.keys()) | set(hl_map.keys())
    for silo in sorted(all_silos):
        meta = silo_meta.get(silo, {})
        code = name = ""
        if "code" in meta and meta["code"][0] + 2 <= L:
            code = s7_get_string(b, meta["code"][0], meta["code"][1])
        if "name" in meta and meta["name"][0] + 2 <= L:
            name = s7_get_string(b, meta["name"][0], meta["name"][1])
        hl = lock = False
        bits = hl_map.get(silo, {})
        if "hl" in bits and bits["hl"][0] < L:
            hl = bool(get_bool(b, bits["hl"][0], bits["hl"][1]))
        if "lock" in bits and bits["lock"][0] < L:
            lock = bool(get_bool(b, bits["lock"][0], bits["lock"][1]))
        rows.append({
            "bin_name": f"Silo {silo}",
            "material_name": name,
            "material_code": code,
            "hl_active": hl,
            "lock_active": lock,
        })
    return rows

def render_silo_qty(b: bytearray, qty_map: Dict[int, Tuple[int, str]]) -> Dict[int, float]:
    """Decode REAL/INT quantities from DB5 buffer. Returns {silo_no: kg}."""
    if not _snap7_loaded:
        return {}
    out: Dict[int, float] = {}
    L = len(b)
    for silo_no, (off, typ) in qty_map.items():
        T = _norm_type(typ)
        need = 4 if T in ("REAL", "DINT") else 2 if T == "INT" else 0
        if need == 0 or off + need > L:
            continue
        try:
            if T == "REAL":
                out[silo_no] = round(get_real(b, off), 3)
            elif T == "INT":
                out[silo_no] = float(get_int(b, off))
        except Exception:
            pass
    return out

def fetch_silo_qty_from_plc() -> Dict[int, float]:
    from routes.silo_qty_map import load_qty_map
    m = load_qty_map(5)
    # Ask for exactly the mapped length. DB5 on site is 492 bytes; the usual +8 margin made the
    # read fail and fall back to 384 bytes, which silently dropped silos 822-848.
    b = read_db_bytes(5, int(m["max_byte"]))
    qty = render_silo_qty(b, m["qty_map"]) if b else {}
    # The plant's own silo blocks are what SCADA shows; DB5 is only a partial copy of them
    # (zero for the 300/600/800/900 groups on site). Where a silo block is known it wins.
    if not DEMO_MODE:
        try:
            svc = silo_block_service()
            if svc is not None:
                qty.update(svc.quantities())
        except Exception as e:
            print(f"[SILO-BLOCKS] read failed, using DB5 only: {e}")
    return qty


_PLC_LINK_ERROR_WORDS = ("tcp", "connect", "socket", "timeout", "timed out", "winerror", "errno",
                         "unreachable", "reset", "refused", "broken pipe", "stale", "recv", "send",
                         "iso ", "not initialized", "job pending")


def _is_plc_link_error(exc: Exception) -> bool:
    """True when the exception means the PLC could not be reached, not that it said no."""
    if isinstance(exc, (OSError, TimeoutError, ConnectionError)):
        return True
    name = type(exc).__name__.lower()
    if "connection" in name or "timeout" in name:
        return True
    msg = str(exc).lower()
    return any(w in msg for w in _PLC_LINK_ERROR_WORDS)


def _plc_read_raw(db_no: int, start: int, size: int) -> Optional[bytes]:
    """Uncached read of part of a data block.

    Returns None when the PLC answers that the block (or that part of it) does not exist.
    Raises services.silo_blocks.PlcUnavailable when the PLC could not be asked at all, so that
    "could not ask" is never mistaken for "does not exist".
    """
    global CLIENT
    from services.silo_blocks import PlcUnavailable
    if DEMO_MODE or not _snap7_loaded:
        raise PlcUnavailable("PLC access is off (demo mode or snap7 missing)")
    for attempt in (1, 2):
        cli = ensure_client()
        if cli is None:
            raise PlcUnavailable("no PLC connection")
        try:
            with CLIENT_LOCK:
                return bytes(cli.db_read(db_no, start, size))
        except Exception as e:
            # The PLC answering "no such block" / "address out of range" is a real answer (wording
            # differs between snap7 versions), so only a recognisable LINK failure counts as
            # "could not ask": reconnect and try once more.
            if not _is_plc_link_error(e):
                return None
            CLIENT = None
            last_error = e
    raise PlcUnavailable(f"PLC read failed: {last_error}")


_SILO_BLOCK_SERVICE = None


def silo_block_service():
    """Shared reader of the plant's per-silo blocks (services/silo_blocks.py). None when switched off."""
    global _SILO_BLOCK_SERVICE
    from services import silo_blocks
    if not silo_blocks.enabled():
        return None
    if _SILO_BLOCK_SERVICE is None:
        def _known_silos():
            from routes.silo_qty_map import QTY_MAP_DB5
            known = set(QTY_MAP_DB5.keys())
            try:
                known.update(int(r["silo_no"]) for r in _app_rows("SELECT silo_no FROM public.silo_status"))
            except Exception:
                pass
            return known
        _SILO_BLOCK_SERVICE = silo_blocks.SiloBlockService(
            read80=lambda db: _plc_read_raw(db, 0, silo_blocks.BLOCK_LEN),
            is_longer=lambda db: _plc_read_raw(db, silo_blocks.BLOCK_LEN, 1) is not None,
            known_silos=_known_silos,
        )
    return _SILO_BLOCK_SERVICE

def _resolve_silo_qty(
    silo_no: int,
    qty_live: Optional[Dict[int, float]],
    db_qty,
) -> float:
    """Live PLC qty when present, else DB snapshot, else 0."""
    if qty_live is not None and silo_no in qty_live:
        return float(qty_live[silo_no])
    if db_qty is not None:
        return float(db_qty)
    return 0.0

STATUS_MAP = {
    0: {"label": "No Status", "kind": "inactive"},
    1: {"label": "Idle", "kind": "idle"},
    2: {"label": "Starting", "kind": "active"},
    6: {"label": "Running", "kind": "active"},
    8: {"label": "Stopping", "kind": "warn"},
    12: {"label": "Completed", "kind": "success"},
}

def _nz(d: Dict[str, Any], key: str, default=None):
    v = d.get(key)
    if isinstance(v, str) and v.strip() == "": return default
    return v if v is not None else default

def _intake_row(lines: Dict[str, Any], k: int):
    p = f"L{k}_"
    if all(_nz(lines, p + s) is None for s in ("BadgeNo","DeclaredQuantity_KG","StatusWord")):
        return None
    code = int(_nz(lines, p + "StatusWord", 0) or 0)
    return {
        "line": k,
        "badge_no":           _nz(lines, p + "BadgeNo"),
        "material_code":      _nz(lines, p + "SourceRawMaterialCode"),
        "declared_qty_kg":    _nz(lines, p + "DeclaredQuantity_KG"),
        "dest1":              _nz(lines, p + "DestinationSilo1"),
        "dest2":              _nz(lines, p + "DestinationSilo2"),
        "rfid_badge_reading": _nz(lines, p + "RFID_BadgeReading"),
        "active_badge":       _nz(lines, p + "ActiveBadge"),
        "active_destination": _nz(lines, p + "ActiveDestination"),
        "status_word": {
            "code":  code,
            "label": STATUS_MAP.get(code, {"label": f"Code {code}"}).get("label"),
            "kind":  STATUS_MAP.get(code, {"kind": "idle"}).get("kind"),
        },
        "dest_sel":        _nz(lines, p + "DEST_SEL"),
        "active_dest_sel": _nz(lines, p + "ACTIVE_DEST_SEL"),
    }

# ───────────────────── Write helpers / guards ───────────────────
def _pack_int(v: int) -> bytes:  return struct.pack(">h", int(v))
def _pack_real(v: float) -> bytes: return struct.pack(">f", float(v))
def _pack_string(s: str, max_len: int) -> bytes:
    s = (s or "")[:max_len]
    data = s.encode("latin-1", errors="ignore")
    pad = b"\x00" * (max_len - len(data))
    return bytes([max_len, len(data)]) + data + pad

def _db_write(db_no: int, byte_offset: int, payload: bytes):
    global CLIENT
    
    if not _snap7_loaded: raise RuntimeError("snap7 missing")
    cli = ensure_client()
    if cli is None: raise RuntimeError("PLC client not connected")
    
    try:
        with CLIENT_LOCK:
            cli.db_write(db_no, byte_offset, payload)
    except Exception as e:
        error_msg = str(e).lower()
        if "connection reset" in error_msg or "tcp" in error_msg:
            print(f"[PLC] TCP connection error during write to DB{db_no}: {e}")
            CLIENT = None
            raise RuntimeError(f"PLC connection lost: {e}")
        else:
            raise RuntimeError(f"PLC write failed: {e}")

def _status_tag_name(area: str, line: Optional[int] = None) -> str:
    if area in ("intake","outloading"): return f"L{line}_StatusWord"
    if area == "bulk": return "BulkLine_Status"
    if area == "pit":  return "PitLine_Status"
    return ""

def _read_status(db_no: int, m: Dict[str, Any], area: str, line: Optional[int]) -> Optional[int]:
    tname = _status_tag_name(area, line)
    hit = _find_tag(m, tname)
    if not hit: return None
    _, off, _, _ = hit
    b = read_db_bytes(db_no, max(32, off + 4))
    if not b: return None
    lines = render_lines(b, m["line_tags"])
    return int(lines.get(tname) or 0)

def _check_silos_allowed(dest_list: List[int]) -> Optional[str]:
    if not CHECK_SILOS: return None
    m3 = load_map_from_pg(3)
    b3 = read_db_bytes(3, _needed_bytes(m3))
    if not b3: return None
    L = len(b3)
    bad = []
    for silo, bits in m3.get("hl_map", {}).items():
        hl = lock = False
        if "hl" in bits and bits["hl"][0] < L:   hl   = bool(get_bool(b3, bits["hl"][0],   bits["hl"][1]))
        if "lock" in bits and bits["lock"][0] < L: lock = bool(get_bool(b3, bits["lock"][0], bits["lock"][1]))
        if (hl or lock) and silo in dest_list:
            bad.append(silo)
    return f"Silos not allowed (HL/LOCK active): {bad}" if bad else None

def _clear_plc_tags(db_no: int, line: int) -> List[str]:
    """Clear all PLC tags for a specific line by setting them to default values"""
    try:
        m = load_map_from_pg(db_no)
        kvs = {
            f"L{line}_BadgeNo": 0,  # Fixed: Use 0 instead of "" for integer fields
            f"L{line}_SourceRawMaterialCode": "",
            f"L{line}_DeclaredQuantity_KG": 0,
            f"L{line}_DestinationSilo1": 0,
            f"L{line}_DestinationSilo2": 0,
        }
        written = _write_tags(db_no, m, kvs)
        print(f"[DEBUG] Cleared PLC tags for DB{db_no}, Line {line}: {written}")
        return written
    except Exception as e:
        print(f"[ERROR] Failed to clear PLC tags for DB{db_no}, Line {line}: {e}")
        return []

def _write_tags(db_no: int, m: Dict[str, Any], kvs: Dict[str, Any]) -> List[str]:
    written = []
    for name, value in kvs.items():
        hit = _find_tag(m, name)
        if not hit: raise ValueError(f"Tag '{name}' not in mapping for DB{db_no}")
        _, off, t, slen = hit
        T = _norm_type(t)
        if T == "INT":
            _db_write(db_no, off, _pack_int(int(value)))
        elif T == "REAL":
            _db_write(db_no, off, _pack_real(float(value)))
        elif T.startswith("STRING["):
            n = int(slen or 32)
            _db_write(db_no, off, _pack_string(str(value or ""), n))
        else:
            raise ValueError(f"Unsupported write type for '{name}': {T}")
        written.append(name)
    return written

# ─────────────────────────── Helper Functions ─────────────────────────
def get_material_name_from_silo(silo_no):
    """Get material name from silo number"""
    try:
        from models import db
        from sqlalchemy import text
        result = db.session.execute(
            text("SELECT material_name FROM public.silo_status WHERE silo_no = :silo_no"),
            {"silo_no": silo_no}
        ).fetchone()
        return result[0] if result and result[0] else ""
    except Exception:
        return ""

def get_material_name_from_code(material_code):
    """Get material name from material code"""
    try:
        from models import db
        from sqlalchemy import text
        result = db.session.execute(
            text("SELECT material_name FROM public.silo_status WHERE material_code = :material_code LIMIT 1"),
            {"material_code": material_code}
        ).fetchone()
        return result[0] if result and result[0] else ""
    except Exception:
        return ""

# ─────────── Plant orders snapshot (HTTP cache vs broadcast dedup) ───────────
_ORDERS_SNAPSHOT_LOCK = threading.RLock()
_LAST_ORDERS_PAYLOAD: Optional[Dict[str, Any]] = None
_LAST_ORDERS_TS: float = 0.0


def _verbose_plc() -> bool:
    """Heavy order/PLC debug logs only when PLC_VERBOSE_LOGS=1/true."""
    return os.getenv("PLC_VERBOSE_LOGS", "").lower() in ("1", "true", "yes")


def _vlog(msg: str) -> None:
    if _verbose_plc():
        print(msg)


# ─────────────────────────── Lifecycle Handler ─────────────────────────
def handle_order_status(order_data, model_class, order_type="intake"):
    """
    Track complete order lifecycle with timestamp buffer and store each order completion.
    Uses buffer system to capture created_at, started_at, and finished_at timestamps.
    """
    # Extract badge number based on order type
    badge = None
    if order_type in ["intake", "outloading"]:
        badge = str(order_data.get("badge_no") or order_data.get("badgeNo") or "")
    elif order_type == "bulk":
        # For bulk orders, use source_silo as identifier
        badge = str(order_data.get("source_silo") or order_data.get("sourceSilo") or "")
    elif order_type == "pit":
        # For pit orders, use pit_no as identifier
        badge = str(order_data.get("pit_no") or order_data.get("pitNo") or "")
    
    status = order_data.get("status_word", {}).get("code") if isinstance(order_data.get("status_word"), dict) else order_data.get("status_word")
    now = datetime.now()  # Use local time instead of UTC

    _vlog(f"[DEBUG] {order_type.upper()} Order {badge}: Raw status_word = {order_data.get('status_word')}")
    _vlog(f"[DEBUG] {order_type.upper()} Order {badge}: Parsed status = {status} (type: {type(status)})")
    _vlog(f"[DEBUG] {order_type.upper()} Order {badge}: Full order_data = {order_data}")

    if not badge or badge == "0" or badge == "":
        _vlog(f"[DEBUG] {order_type.upper()} Order: Badge is empty or invalid: '{badge}'")
        _vlog(f"[DEBUG] {order_type.upper()} Order: Raw badge_no from data: '{order_data.get('badge_no')}'")
        _vlog(f"[DEBUG] {order_type.upper()} Order: Raw badgeNo from data: '{order_data.get('badgeNo')}'")
        return

    # Convert status to int for comparison (handle both string and int)
    status_int = int(status) if status is not None else 0
    
    # Get destination silos for this order to create unique key
    dest1 = str(order_data.get("dest1") or order_data.get("destinationSilo1") or "")
    dest2 = str(order_data.get("dest2") or order_data.get("destinationSilo2") or "")
    order_key = f"{order_type}_{badge}_{dest1}_{dest2}"
    
    # 📊 TIMESTAMP BUFFER: Track timestamps for each status
    if status_int == 1:
        # Status 1 (Idle) → Record created_at timestamp only if not already recorded, then check for completed order
        if order_key not in _order_timestamps_buffer or "created_at" not in _order_timestamps_buffer[order_key]:
            _vlog(f"[TIMESTAMP] {order_type.upper()} Order {badge}: Status 1 (Idle) - Recording created_at timestamp")
            _update_timestamp_buffer(order_key, "created_at", now)
        else:
            _vlog(f"[TIMESTAMP] {order_type.upper()} Order {badge}: Status 1 (Idle) - Already recorded created_at, checking for completed order")
        _store_completed_order_if_ready(order_data, model_class, order_type, badge, now)
        
    elif status_int in [2, 3, 4, 5, 6, 7]:
        # Status 2-7 (Running) → Record started_at timestamp (only once)
        if order_key not in _order_timestamps_buffer or "started_at" not in _order_timestamps_buffer[order_key]:
            _vlog(f"[TIMESTAMP] {order_type.upper()} Order {badge}: Status {status_int} (Running) - Recording started_at timestamp")
            _update_timestamp_buffer(order_key, "started_at", now)
        else:
            _vlog(f"[TIMESTAMP] {order_type.upper()} Order {badge}: Status {status_int} (Running) - Already recorded started_at")
            
    elif status_int in [8, 12]:
        # Status 8 (Stopping) or 12 (Completed) → Record finished_at timestamp and mark ready for storage
        status_name = "Stopping" if status_int == 8 else "Completed"
        _vlog(f"[TIMESTAMP] {order_type.upper()} Order {badge}: Status {status_int} ({status_name}) - Recording finished_at timestamp")
        _vlog(f"[TIMESTAMP] {order_type.upper()} Order {badge}: Order key = {order_key}")
        _vlog(f"[TIMESTAMP] {order_type.upper()} Order {badge}: Model class = {model_class}")
        _update_timestamp_buffer(order_key, "finished_at", now)
        _mark_order_ready_for_storage(order_data, model_class, order_type, badge, now)
        
    else:
        # For other statuses, just log
        if status_int and status_int != 1:  # Don't log idle status (too frequent)
            _vlog(f"[TIMESTAMP] {order_type.upper()} Order {badge}: Status {status_int} (unknown - tracking progress)")
        return

# Global dictionary to track order lifecycle states
_order_lifecycle_tracker = {}

# Global dictionary to track order timestamps buffer
_order_timestamps_buffer = {}

# Truck/client metadata set at order create (PLC does not carry these fields)
_order_pending_metadata: dict[str, dict] = {}


def _compute_order_key(order_type: str, data: dict) -> Optional[str]:
    if order_type in ("intake", "outloading"):
        badge = str(data.get("badge_no") or data.get("badgeNo") or "")
    elif order_type == "bulk":
        badge = str(data.get("source_silo") or data.get("sourceSilo") or "")
    elif order_type == "pit":
        badge = str(data.get("pit_no") or data.get("pitNo") or "")
    else:
        return None
    if not badge or badge in ("0", ""):
        return None
    dest1 = str(data.get("dest1") or data.get("destinationSilo1") or "")
    dest2 = str(data.get("dest2") or data.get("destinationSilo2") or "")
    return f"{order_type}_{badge}_{dest1}_{dest2}"


def _stash_order_metadata(order_type: str, data: dict) -> None:
    truck_id = data.get("truck_id")
    client_id = data.get("client_id")
    if truck_id is None and client_id is None:
        return
    key = _compute_order_key(order_type, data)
    if not key:
        return
    _order_pending_metadata[key] = {
        "truck_id": int(truck_id) if truck_id not in (None, "") else None,
        "client_id": int(client_id) if client_id not in (None, "") else None,
    }
    _vlog(f"[METADATA] Stashed truck/client for {key}: {_order_pending_metadata[key]}")


def _pop_order_metadata(order_key: str) -> dict:
    return _order_pending_metadata.pop(order_key, {})

def _update_timestamp_buffer(order_key, timestamp_type, timestamp):
    """Update the timestamp buffer for an order"""
    if order_key not in _order_timestamps_buffer:
        _order_timestamps_buffer[order_key] = {}
    
    _order_timestamps_buffer[order_key][timestamp_type] = timestamp
    _vlog(f"[BUFFER] Updated {order_key}: {timestamp_type} = {timestamp.strftime('%Y-%m-%d %H:%M:%S')}")

def _get_timestamp_buffer(order_key):
    """Get all timestamps from buffer for an order"""
    return _order_timestamps_buffer.get(order_key, {})

def _clear_timestamp_buffer(order_key):
    """Clear timestamp buffer for an order after storage"""
    if order_key in _order_timestamps_buffer:
        del _order_timestamps_buffer[order_key]
        _vlog(f"[BUFFER] Cleared timestamp buffer for {order_key}")

def _mark_order_ready_for_storage(order_data, model_class, order_type, badge, now):
    """Mark order as ready for storage when status 8 (stopped) is reached"""
    try:
        # Get destination silos for this order
        dest1 = str(order_data.get("dest1") or order_data.get("destinationSilo1") or "")
        dest2 = str(order_data.get("dest2") or order_data.get("destinationSilo2") or "")
        
        # Create unique key for this order combination
        order_key = f"{order_type}_{badge}_{dest1}_{dest2}"
        
        # Store order data and mark as ready for storage
        _order_lifecycle_tracker[order_key] = {
            "order_data": order_data,
            "model_class": model_class,
            "order_type": order_type,
            "badge": badge,
            "dest1": dest1,
            "dest2": dest2,
            "stopped_at": now,
            "ready_for_storage": True
        }
        
        _vlog(f"[LIFECYCLE] 📝 Order {badge} with silos {dest1}/{dest2} marked as ready for storage")
        if order_type == "outloading":
            _vlog(f"[LIFECYCLE] OUTLOADING DEBUG: Order key = {order_key}")
            _vlog(f"[LIFECYCLE] OUTLOADING DEBUG: Model class = {model_class}")
            _vlog(f"[LIFECYCLE] OUTLOADING DEBUG: Order data keys = {list(order_data.keys())}")
        
    except Exception as e:
        print(f"[LIFECYCLE] ❌ ERROR! Failed to mark order {badge} as ready: {e}")

def _store_completed_order_if_ready(order_data, model_class, order_type, badge, now):
    """Store completed order when status 1 (idle) is reached after status 8 (stopped)"""
    try:
        # Get destination silos for this order
        dest1 = str(order_data.get("dest1") or order_data.get("destinationSilo1") or "")
        dest2 = str(order_data.get("dest2") or order_data.get("destinationSilo2") or "")
        
        # Create unique key for this order combination
        order_key = f"{order_type}_{badge}_{dest1}_{dest2}"
        
        # Check if this order is ready for storage
        if order_key in _order_lifecycle_tracker and _order_lifecycle_tracker[order_key]["ready_for_storage"]:
            order_info = _order_lifecycle_tracker[order_key]
            
            if order_type == "outloading":
                _vlog(f"[LIFECYCLE] OUTLOADING DEBUG: Found ready order in tracker: {order_key}")
                _vlog(f"[LIFECYCLE] OUTLOADING DEBUG: Order info = {order_info}")
            
            # Store the completed order
            _store_complete_order_with_lifecycle(
                order_info["order_data"], 
                order_info["model_class"], 
                order_info["order_type"], 
                order_info["badge"], 
                order_info["stopped_at"],  # finished_at timestamp
                now  # idle_at timestamp
            )
            
            # Remove from tracker
            del _order_lifecycle_tracker[order_key]
            _vlog(f"[LIFECYCLE] ✅ Order {badge} with silos {dest1}/{dest2} stored and removed from tracker")
        else:
            _vlog(f"[LIFECYCLE] ℹ️ Order {badge} with silos {dest1}/{dest2} not ready for storage (no previous stopped status)")
            if order_type == "outloading":
                _vlog(f"[LIFECYCLE] OUTLOADING DEBUG: Order key not in tracker: {order_key}")
                _vlog(f"[LIFECYCLE] OUTLOADING DEBUG: Available keys in tracker: {list(_order_lifecycle_tracker.keys())}")
            
    except Exception as e:
        print(f"[LIFECYCLE] ❌ ERROR! Failed to store completed order {badge}: {e}")

def _store_complete_order_with_lifecycle(order_data, model_class, order_type, badge, finished_at, idle_at):
    """Store complete order with full lifecycle timestamps from buffer"""
    try:
        # Get destination silos for this order
        dest1 = str(order_data.get("dest1") or order_data.get("destinationSilo1") or "")
        dest2 = str(order_data.get("dest2") or order_data.get("destinationSilo2") or "")
        order_key = f"{order_type}_{badge}_{dest1}_{dest2}"
        
        # Get timestamps from buffer
        timestamps = _get_timestamp_buffer(order_key)
        created_at = timestamps.get("created_at", finished_at)  # Fallback to finished_at if not available
        started_at = timestamps.get("started_at", finished_at)  # Fallback to finished_at if not available
        finished_at_from_buffer = timestamps.get("finished_at", finished_at)  # Use buffer value or fallback
        
        _vlog(f"[LIFECYCLE] Using timestamps from buffer for {order_key}:")
        _vlog(f"[LIFECYCLE]   created_at: {created_at.strftime('%Y-%m-%d %H:%M:%S')}")
        _vlog(f"[LIFECYCLE]   started_at: {started_at.strftime('%Y-%m-%d %H:%M:%S')}")
        _vlog(f"[LIFECYCLE]   finished_at: {finished_at_from_buffer.strftime('%Y-%m-%d %H:%M:%S')}")
        _vlog(f"[LIFECYCLE]   idle_at: {idle_at.strftime('%Y-%m-%d %H:%M:%S')}")
        
        meta = _pop_order_metadata(order_key)
        truck_id = meta.get("truck_id")
        client_id = meta.get("client_id")
        
        # Verify chronological order
        if created_at <= started_at <= finished_at_from_buffer <= idle_at:
            _vlog(f"[LIFECYCLE] ✅ Timestamps are in correct chronological order")
        else:
            _vlog(f"[LIFECYCLE] ⚠️ WARNING: Timestamps are NOT in chronological order!")
            _vlog(f"[LIFECYCLE]   Created: {created_at.strftime('%H:%M:%S')}")
            _vlog(f"[LIFECYCLE]   Started: {started_at.strftime('%H:%M:%S')}")
            _vlog(f"[LIFECYCLE]   Finished: {finished_at_from_buffer.strftime('%H:%M:%S')}")
            _vlog(f"[LIFECYCLE]   Idle: {idle_at.strftime('%H:%M:%S')}")
        
        # Create complete order with all timestamps
        if order_type == "outloading":
            _vlog(f"[LIFECYCLE] OUTLOADING DEBUG: Creating outloading order with data: {order_data}")
            _vlog(f"[LIFECYCLE] OUTLOADING DEBUG: Model class: {model_class}")
            _vlog(f"[LIFECYCLE] OUTLOADING DEBUG: Badge: {badge}, Dest1: {dest1}, Dest2: {dest2}")
        
        if order_type == "intake":
            # Get material names from silos and material codes
            dest1_material_name = get_material_name_from_silo(int(dest1)) if dest1.isdigit() else ""
            dest2_material_name = get_material_name_from_silo(int(dest2)) if dest2.isdigit() else ""
            
            # Get source material name from material code
            source_material_code = order_data.get("material_code") or order_data.get("sourceMaterialCode") or ""
            source_material_name = get_material_name_from_code(source_material_code) if source_material_code else ""
            
            order = model_class(
                badge_no=badge,
                source_material_code=source_material_code,
                source_material_name=source_material_name,
                declared_quantity_kg=order_data.get("declared_qty_kg") or order_data.get("declaredQuantityKG") or 0,
                destination_silo1=dest1,
                destination_silo1_material_name=dest1_material_name,
                destination_silo2=dest2,
                destination_silo2_material_name=dest2_material_name,
                rfid_badge_reading=badge,
                active_badge=badge,
                active_destination=dest1,
                status_word="8",  # Status 8 (Stopping/Finished)
                line=order_data.get("line", "1"),
                truck_id=truck_id,
                client_id=client_id,
                created_at=created_at,  # Use timestamp from buffer
                started_at=started_at,  # Use timestamp from buffer
                finished_at=finished_at_from_buffer,  # Use timestamp from buffer
                idle_at=idle_at,  # Set idle_at when order goes back to idle
                updated_at=idle_at,
                is_complete=True  # Mark as complete since order cycle is done
            )
        elif order_type == "outloading":
            # Get material names from silos and material codes
            dest1_material_name = get_material_name_from_silo(int(dest1)) if dest1.isdigit() else ""
            dest2_material_name = get_material_name_from_silo(int(dest2)) if dest2.isdigit() else ""
            
            # Get source material name from material code
            source_material_code = order_data.get("material_code") or order_data.get("sourceMaterialCode") or ""
            source_material_name = get_material_name_from_code(source_material_code) if source_material_code else ""
            
            order = model_class(
                badge_no=badge,
                source_material_code=source_material_code,
                source_material_name=source_material_name,
                rfid_set=badge,
                declared_quantity_kg=order_data.get("declared_qty_kg") or order_data.get("declaredQuantityKG") or 0,
                destination_silo1=dest1,
                destination_silo1_material_name=dest1_material_name,
                destination_silo2=dest2,
                destination_silo2_material_name=dest2_material_name,
                rfid_badge_reading=badge,
                active_badge=badge,
                active_destination=dest1,
                status_word="8",  # Status 8 (Stopping/Finished)
                activ_dest_set=str(order_data.get("dest_sel") or order_data.get("dest1") or ""),
                line=str(order_data.get("line", "1")),  # Add line field
                truck_id=truck_id,
                client_id=client_id,
                created_at=created_at,  # Use timestamp from buffer
                started_at=started_at,  # Use timestamp from buffer
                finished_at=finished_at_from_buffer,  # Use timestamp from buffer
                idle_at=idle_at,  # Set idle_at when order goes back to idle
                updated_at=idle_at,
                is_complete=True  # Mark as complete since order cycle is done
            )
            _vlog(f"[LIFECYCLE] OUTLOADING DEBUG: Created outloading order object: {order}")
        elif order_type == "bulk":
            # Get material names from silos
            source_silo = badge
            source_material_name = get_material_name_from_silo(int(source_silo)) if source_silo.isdigit() else ""
            dest1_material_name = get_material_name_from_silo(int(dest1)) if dest1.isdigit() else ""
            dest2_material_name = get_material_name_from_silo(int(dest2)) if dest2.isdigit() else ""
            
            order = model_class(
                source_silo=source_silo,
                source_material_name=source_material_name,
                destination_silo1=dest1,
                destination_silo1_material_name=dest1_material_name,
                destination_silo2=dest2,
                destination_silo2_material_name=dest2_material_name,
                cc25_sel=str(order_data.get("cc25_sel") or order_data.get("cc25Sel") or ""),
                declared_quantity_kg=order_data.get("declared_qty_kg") or order_data.get("declaredQuantityKG") or 0.0,
                scale_sel=str(order_data.get("scale_sel") or order_data.get("scaleSel") or ""),
                status_word="8",  # Status 8 (Stopping/Finished)
                truck_id=truck_id,
                client_id=client_id,
                created_at=created_at,  # Use timestamp from buffer
                started_at=started_at,  # Use timestamp from buffer
                finished_at=finished_at_from_buffer,  # Use timestamp from buffer
                idle_at=idle_at,  # Set idle_at when order goes back to idle
                updated_at=idle_at,
                is_complete=True  # Mark as complete since order cycle is done
            )
        elif order_type == "pit":
            # Get material names from silos and raw material codes
            dest1_material_name = get_material_name_from_silo(int(dest1)) if dest1.isdigit() else ""
            dest2_material_name = get_material_name_from_silo(int(dest2)) if dest2.isdigit() else ""
            
            # Get raw material name from raw code
            raw_code = order_data.get("raw_code") or order_data.get("rawCode") or ""
            raw_material_name = get_material_name_from_code(raw_code) if raw_code else ""
            
            order = model_class(
                pit_no=badge,
                raw_code=raw_code,
                raw_material_name=raw_material_name,
                destination_silo1=dest1,
                destination_silo1_material_name=dest1_material_name,
                destination_silo2=dest2,
                destination_silo2_material_name=dest2_material_name,
                declared_quantity_kg=order_data.get("declared_qty_kg") or order_data.get("declaredQuantityKG") or 0.0,
                scale_sel=str(order_data.get("scale_sel") or order_data.get("scaleSel") or ""),
                status_word="8",  # Status 8 (Stopping/Finished)
                truck_id=truck_id,
                client_id=client_id,
                created_at=created_at,  # Use timestamp from buffer
                started_at=started_at,  # Use timestamp from buffer
                finished_at=finished_at_from_buffer,  # Use timestamp from buffer
                idle_at=idle_at,  # Set idle_at when order goes back to idle
                updated_at=idle_at,
                is_complete=True  # Mark as complete since order cycle is done
            )
        
        db.session.add(order)
        _vlog(f"[LIFECYCLE] OUTLOADING DEBUG: Added {order_type} order to database session")
        db.session.commit()
        _vlog(f"[LIFECYCLE] ✅ SUCCESS! {order_type.upper()} Order {badge} stored with ID: {order.id}")
        if order_type == "outloading":
            _vlog(f"[LIFECYCLE] OUTLOADING DEBUG: Successfully committed outloading order {badge} to database with ID: {order.id}")
        
        # Get material info for logging based on order type
        if order_type == "pit":
            material_info = order_data.get("raw_code") or order_data.get("rawCode") or "N/A"
        else:
            material_info = order_data.get("material_code") or order_data.get("sourceMaterialCode") or "N/A"
        
        _vlog(f"[LIFECYCLE] 📊 Order details: Material={material_info}, Qty={order_data.get('declared_qty_kg', 'N/A')}kg, Dest1={dest1}, Dest2={dest2}")
        _vlog(f"[LIFECYCLE] ⏰ Lifecycle: Created at {created_at}, Started at {started_at}, Finished at {finished_at_from_buffer}, Idle at {idle_at}")
        
        # Clear the timestamp buffer for this order after successful storage
        _clear_timestamp_buffer(order_key)
        
    except Exception as e:
        print(f"[LIFECYCLE] ❌ ERROR! Failed to store {order_type.upper()} Order {badge}: {e}")
        db.session.rollback()
        raise

# ─────────────────────────── PLC Routes ─────────────────────────
@plc_bp.route("/info")
def plc_info():
    return jsonify({
        "snap7_loaded": _snap7_loaded,
        "demo_mode": DEMO_MODE,
        "plc": {"ip": PLC_IP, "rack": PLC_RACK, "slot": PLC_SLOT},
        "default_db": DEFAULT_DB,
        "read_len_cap": READ_LEN_CAP,
        "check_silos": CHECK_SILOS,
        "db_cache": _DB_CACHE,
        "timestamp": datetime.now().isoformat()
    })

@plc_bp.route("/health")
def plc_health():
    """Check PLC connection health"""
    try:
        is_healthy = check_plc_health()
        return jsonify({
            "healthy": is_healthy,
            "connected": CLIENT is not None and CLIENT.get_connected() if CLIENT else False,
            "snap7_loaded": _snap7_loaded,
            "demo_mode": DEMO_MODE,
            "timestamp": datetime.now().isoformat()
        })
    except Exception as e:
        return jsonify({
            "healthy": False,
            "connected": False,
            "error": str(e),
            "timestamp": datetime.now().isoformat()
        }), 503

@plc_bp.route("/db/<int:db_no>/probe")
def db_probe(db_no: int):
    m = load_map_from_pg(db_no)
    need = _needed_bytes(m)
    _DB_CACHE.pop(db_no, None)  # force fresh probe
    b = read_db_bytes(db_no, need)
    ent = _DB_CACHE.get(db_no, {})
    return jsonify({
        "db": db_no,
        "mapping_max_byte_needed": need,
        "last_good_len": ent.get("good_len"),
        "absent_until": ent.get("absent_until", 0),
        "connected": b is not None,
        "buffer_len": len(b) if b else 0,
        "timestamp": datetime.now().isoformat()
    })

@plc_bp.route("/db/<int:db_no>/health")
def db_health(db_no: int):
    m = load_map_from_pg(db_no)
    need = _needed_bytes(m)
    b = read_db_bytes(db_no, need)
    ent = _DB_CACHE.get(db_no, {})
    return jsonify({
        "db": db_no,
        "connected": b is not None,
        "buffer_len": len(b) if b else 0,
        "last_good_len": ent.get("good_len"),
        "absent_until": ent.get("absent_until", 0),
        "max_byte_needed": need,
        "timestamp": datetime.now().isoformat()
    })

@plc_bp.route("/db/<int:db_no>/lines")
def db_lines(db_no: int):
    m = load_map_from_pg(db_no)
    b = read_db_bytes(db_no, _needed_bytes(m))
    if not b:
        return jsonify({"error": "PLC unreachable or DB absent"}), 503
    return jsonify(render_lines(b, m["line_tags"]))

@plc_bp.route("/db/<int:db_no>/silos")
def db_silos(db_no: int):
    """Direct PLC view of silos for that DB (usually DB3)."""
    m = load_map_from_pg(db_no)
    b = read_db_bytes(db_no, _needed_bytes(m))
    if not b:
        return jsonify({"error": "PLC unreachable or DB absent"}), 503
    return jsonify(render_silos(b, m["silo_meta"], m["hl_map"]))

@plc_bp.route("/db/5/silos-qty", methods=["GET"])
def db5_silos_qty():
    """Live PLC view of silo quantities from DB5."""
    qty = fetch_silo_qty_from_plc()
    if not qty and not DEMO_MODE:
        return jsonify({"error": "PLC unreachable or DB5 absent"}), 503
    return jsonify([
        {"siloNo": k, "binName": f"Silo {k}", "quantityKg": v}
        for k, v in sorted(qty.items())
    ])

@plc_bp.route("/db/<int:db_no>/orders")
def db_orders(db_no: int):
    m = load_map_from_pg(db_no)
    b = read_db_bytes(db_no, _needed_bytes(m))
    if not b:
        return jsonify({"intake": []})
    lines = render_lines(b, m["line_tags"])
    intake = [r for r in (_intake_row(lines, k) for k in (1,2,3)) if r]
    resp: Dict[str, Any] = {"intake": intake}
    
    # Special handling for DB3 to show all available tags
    if db_no == 3:
        resp["debug_info"] = {
            "available_tags": [n for n, *_ in m["line_tags"]],
            "raw_lines": lines
        }

    if any(n.startswith("BulkLine_") for n, *_ in m["line_tags"]):
        resp["bulk"] = {
            "line": "Bulk",
            "source_silo": _nz(lines,"BulkLine_Source_Silo"),
            "dest1": _nz(lines,"BulkLine_DEST_1"),
            "dest2": _nz(lines,"BulkLine_DEST_2"),
            "cc25_sel": _nz(lines,"BulkLine_CC25_Sel"),
            "declared_qty_kg": _nz(lines,"BulkLine_Weight_Quantity"),
            "scale_sel": _nz(lines,"BulkLine_Scale_Selection"),
            "status_word": {"code": _nz(lines,"BulkLine_Status",0)},
            "active": {
                "source_silo": _nz(lines,"ActiveBulk_Source_Silo"),
                "dest1": _nz(lines,"ActiveBulk_DEST_1"),
                "dest2": _nz(lines,"ActiveBulk_DEST_2"),
                "cc25_sel": _nz(lines,"ActiveBulk_CC25_Sel"),
                "qty_kg": _nz(lines,"ActiveBulk_weightQuant"),
                "scale_sel": _nz(lines,"ActiveBulk_ScaleSelect"),
            }
        }

    if any(n.startswith("PitLine_") or n.startswith("ActivePit_") for n, *_ in m["line_tags"]):
        resp["pit"] = {
            "line": "Pit",
            "pit_no": _nz(lines,"PitLine_Pit_Number"),
            "raw_code": _nz(lines,"PitLine_RawMaterialCode"),
            "dest1": _nz(lines,"PitLine_DEST_1"),
            "dest2": _nz(lines,"PitLine_DEST_2"),
            "declared_qty_kg": _nz(lines,"PitLine_Weight_Quantity"),
            "scale_sel": _nz(lines,"PitLine_Scale_Selection"),
            "status_word": {"code": _nz(lines,"PitLine_Status",0)},
            "active": {
                "pit_no": _nz(lines,"ActivePit_Pit_Number"),
                "raw_code": _nz(lines,"ActivePit_RawMaterialCod"),
                "dest1": _nz(lines,"ActivePit_DEST_1"),
                "dest2": _nz(lines,"ActivePit_DEST_2"),
                "qty_kg": _nz(lines,"ActivePit_Weight_Quant"),
                "scale_sel": _nz(lines,"ActivePit_Scale_Select"),
            }
        }
    return jsonify(resp)

# ══════════════════════════════════════════════════════════════════════════
# Live Order Queue — multi-order creation + sequential RFID-matched dispatch
# ══════════════════════════════════════════════════════════════════════════
# Orders are enqueued as WAITING rows (never written to the PLC at create time).
# A single dispatcher writes exactly ONE order per PLC line, only when that line
# is Idle and (for RFID lines) the scanned tag matches a waiting order. This
# structurally prevents a second order from overwriting a running order's tags.

# Strict RFID matching: only dispatch a waiting order when the PLC-scanned RFID
# matches it. Set QUEUE_STRICT_RFID=0 to fall back to FIFO when no tag is scanned.
QUEUE_STRICT_RFID = os.getenv("QUEUE_STRICT_RFID", "1").lower() in ("1", "true", "yes")

_QUEUE_LOCK = threading.RLock()


def _q_int(v, default: int = 0) -> int:
    """Coerce a possibly-string/float value to int for PLC INT tags."""
    try:
        if v is None or (isinstance(v, str) and v.strip() == ""):
            return default
        return int(float(v))
    except (TypeError, ValueError):
        return default


def _q_float(v, default: float = 0.0) -> float:
    try:
        if v is None or (isinstance(v, str) and v.strip() == ""):
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def _normalize_rfid(v) -> str:
    """Normalize an RFID value (REAL from PLC, or string) to a comparable string."""
    if v is None:
        return ""
    if isinstance(v, str):
        v = v.strip()
        if v == "":
            return ""
        try:
            return str(int(float(v)))
        except ValueError:
            return v
    try:
        return str(int(round(float(v))))
    except (TypeError, ValueError):
        return str(v)


def _order_kvs(row) -> Dict[str, Any]:
    """Build the PLC tag dict for a queued order row (same tags used at create)."""
    ot = row.order_type
    if ot in ("intake", "mineral"):
        ln = row.line
        return {
            f"L{ln}_BadgeNo":               _q_int(row.badge_no),
            f"L{ln}_SourceRawMaterialCode": row.material_code or "",
            f"L{ln}_DeclaredQuantity_KG":   _q_float(row.declared_qty_kg),
            f"L{ln}_DestinationSilo1":      _q_int(row.dest1),
            f"L{ln}_DestinationSilo2":      _q_int(row.dest2),
        }
    if ot == "outloading":
        ln = row.line
        return {
            f"L{ln}_BadgeNo":               _q_int(row.badge_no),
            f"L{ln}_SourceRawMaterialCode": row.material_code or "",
            f"L{ln}_DeclaredQuantity_KG":   _q_float(row.declared_qty_kg),
            f"L{ln}_DestinationSilo1":      _q_int(row.dest1),
            f"L{ln}_DestinationSilo2":      _q_int(row.dest2),
            f"L{ln}_DEST_SEL":              _q_int(row.dest_sel),
        }
    if ot == "bulk":
        return {
            "BulkLine_Source_Silo":     _q_int(row.source_silo),
            "BulkLine_DEST_1":          _q_int(row.dest1),
            "BulkLine_DEST_2":          _q_int(row.dest2),
            "BulkLine_CC25_Sel":        _q_int(row.cc25_sel),
            "BulkLine_Weight_Quantity": _q_float(row.declared_qty_kg),
            "BulkLine_Scale_Selection": _q_int(row.scale_sel),
        }
    if ot == "pit":
        return {
            "PitLine_Pit_Number":      _q_int(row.pit_no),
            "PitLine_RawMaterialCode": row.raw_code or "",
            "PitLine_DEST_1":          _q_int(row.dest1),
            "PitLine_DEST_2":          _q_int(row.dest2),
            "PitLine_Weight_Quantity": _q_float(row.declared_qty_kg),
            "PitLine_Scale_Selection": _q_int(row.scale_sel),
        }
    raise ValueError(f"Unknown order_type: {ot}")


def _release_rfid(rfid_number: Optional[str]) -> None:
    """Unlock an RFID tag so it can be used by a new order."""
    if not rfid_number:
        return
    try:
        cfg = RFIDConfig.query.filter_by(rfid_number=str(rfid_number)).first()
        if cfg and cfg.rfid_used:
            cfg.rfid_used = False
            cfg.rfid_linked_to_order = None
    except Exception as e:
        _vlog(f"[QUEUE] Failed releasing RFID {rfid_number}: {e}")


def _complete_queue_row(row, now) -> None:
    from models.order_queue import QUEUE_COMPLETED
    row.queue_status = QUEUE_COMPLETED
    row.completed_at = now
    _release_rfid(row.rfid_number)
    db.session.commit()
    _vlog(f"[QUEUE] ✅ Completed queue #{row.id} ({row.order_type} line {row.line}), RFID {row.rfid_number} released")


def _dispatch_next(ctx: Dict[str, Any], now) -> bool:
    """Write the next matching WAITING order for this line onto the PLC."""
    from models.order_queue import OrderQueue, QUEUE_WAITING, QUEUE_DISPATCHED

    order_type = ctx["order_type"]
    line = ctx["line"]

    waiting = (
        OrderQueue.query
        .filter(OrderQueue.order_type == order_type,
                OrderQueue.line == line,
                OrderQueue.queue_status == QUEUE_WAITING)
        .order_by(OrderQueue.queue_position.asc(), OrderQueue.created_at.asc())
        .all()
    )
    if not waiting:
        return False

    is_rfid_line = order_type in ("intake", "mineral", "outloading")
    scanned = _normalize_rfid(ctx.get("scanned_rfid")) if is_rfid_line else ""

    target = None
    if is_rfid_line:
        if scanned:
            for w in waiting:
                if _normalize_rfid(w.rfid_number) == scanned:
                    target = w
                    break
            if target is None and QUEUE_STRICT_RFID:
                _vlog(f"[QUEUE] line {line}: scanned RFID {scanned} matches no waiting order")
                return False
        if target is None and QUEUE_STRICT_RFID:
            # No tag scanned yet → wait for a truck to present its RFID.
            return False

    if target is None:
        target = waiting[0]  # FIFO (bulk/pit, or non-strict mode)

    try:
        m = load_map_from_pg(target.db_no)
        kvs = _order_kvs(target)
        _write_tags(target.db_no, m, kvs)
    except Exception as e:
        db.session.rollback()
        print(f"[QUEUE] ❌ PLC write failed dispatching queue #{target.id}: {e}")
        return False

    target.queue_status = QUEUE_DISPATCHED
    target.dispatched_at = now
    db.session.commit()
    _vlog(f"[QUEUE] 🚚 Dispatched queue #{target.id} ({order_type} line {line}) RFID {target.rfid_number}")
    return True


def _process_queue_line(ctx: Dict[str, Any], now) -> None:
    from models.order_queue import OrderQueue, QUEUE_RUNNING, ACTIVE_STATUSES

    order_type = ctx["order_type"]
    line = ctx["line"]
    status = int(ctx.get("status") or 0)

    active = (
        OrderQueue.query
        .filter(OrderQueue.order_type == order_type,
                OrderQueue.line == line,
                OrderQueue.queue_status.in_(list(ACTIVE_STATUSES)))
        .order_by(OrderQueue.dispatched_at.asc())
        .first()
    )

    if active:
        if status in (2, 3, 4, 5, 6, 7, 8, 12):
            # Line has left Idle → the dispatched order is now running.
            if active.queue_status != QUEUE_RUNNING:
                active.queue_status = QUEUE_RUNNING
                active.started_at = active.started_at or now
                db.session.commit()
            return
        if status == 1:
            if active.queue_status == QUEUE_RUNNING:
                # Was running, now back to Idle → complete it and free the line.
                _complete_queue_row(active, now)
                # fall through to dispatch the next waiting order
            else:
                # DISPATCHED but still Idle → waiting for operator/PLC to start.
                return
        else:
            return

    if status == 1:
        _dispatch_next(ctx, now)


def _reconcile_rfid_usage(contexts: List[Dict[str, Any]]) -> None:
    """Keep RFIDConfig.rfid_used in sync with the real PLC state each poll.

    A tag is considered "in use" when it is either loaded on a live PLC line
    (badge present) or attached to an open queue row (WAITING/DISPATCHED/RUNNING).
    Any tag marked used that is neither is released so it becomes selectable again.
    """
    from models.order_queue import OrderQueue, QUEUE_WAITING, QUEUE_DISPATCHED, QUEUE_RUNNING

    # 1) Badges currently loaded on the PLC (RFID-based lines only).
    live_labels: Dict[str, str] = {}
    for ctx in contexts:
        if ctx.get("order_type") not in ("intake", "mineral", "outloading"):
            continue
        badge = _normalize_rfid(ctx.get("badge"))
        if badge and badge != "0":
            live_labels[badge] = f"LIVE-{ctx['order_type']}-{ctx['line']}"

    # 2) RFIDs held by any open queue row (must never be released here).
    queue_rfids = set()
    open_rows = (
        OrderQueue.query
        .filter(OrderQueue.queue_status.in_([QUEUE_WAITING, QUEUE_DISPATCHED, QUEUE_RUNNING]))
        .all()
    )
    for r in open_rows:
        n = _normalize_rfid(r.rfid_number)
        if n:
            queue_rfids.add(n)

    try:
        # 3) Lock every live badge (create a config row if we've never seen it).
        for badge, label in live_labels.items():
            cfg = RFIDConfig.query.filter_by(rfid_number=badge).first()
            if not cfg:
                cfg = RFIDConfig(rfid_number=badge, rfid_used=True, rfid_linked_to_order=label)
                db.session.add(cfg)
                continue
            cfg.rfid_used = True
            # Don't clobber a queue-owned label; otherwise reflect the live line.
            if not (cfg.rfid_linked_to_order or "").startswith("QUEUE-"):
                cfg.rfid_linked_to_order = label

        # 4) Release tags that are used but no longer live and not queued.
        used_cfgs = RFIDConfig.query.filter(RFIDConfig.rfid_used.is_(True)).all()
        for cfg in used_cfgs:
            n = _normalize_rfid(cfg.rfid_number)
            if n in live_labels or n in queue_rfids:
                continue
            cfg.rfid_used = False
            cfg.rfid_linked_to_order = None

        db.session.commit()
    except Exception as e:
        db.session.rollback()
        print(f"[QUEUE] RFID reconciliation failed: {e}")


def process_order_queue(contexts: List[Dict[str, Any]]) -> None:
    """Run the queue state machine for every PLC line (called each poll)."""
    with _QUEUE_LOCK:
        for ctx in contexts:
            try:
                _process_queue_line(ctx, datetime.now())
            except Exception as e:
                db.session.rollback()
                print(f"[QUEUE] error processing line {ctx.get('order_type')}/{ctx.get('line')}: {e}")
        try:
            _reconcile_rfid_usage(contexts)
        except Exception as e:
            db.session.rollback()
            print(f"[QUEUE] RFID reconciliation error: {e}")


def _queue_ctx(order_type: str, db_no: int, line: int, lines_dict: Dict[str, Any]) -> Dict[str, Any]:
    """Extract PLC status + scanned RFID for a line from its rendered tag dict."""
    badge = ""
    if order_type in ("intake", "mineral", "outloading"):
        status = int(_nz(lines_dict, f"L{line}_StatusWord", 0) or 0)
        scanned = _nz(lines_dict, f"L{line}_RFID_BadgeReading")
        badge = _normalize_rfid(_nz(lines_dict, f"L{line}_BadgeNo"))
    elif order_type == "bulk":
        status = int(_nz(lines_dict, "BulkLine_Status", 0) or 0)
        scanned = None
    elif order_type == "pit":
        status = int(_nz(lines_dict, "PitLine_Status", 0) or 0)
        scanned = None
    else:
        status, scanned = 0, None
    return {"order_type": order_type, "db_no": db_no, "line": line,
            "status": status, "scanned_rfid": scanned, "badge": badge}


def _execute_plant_orders() -> Dict[str, Any]:
    """
    Reads live orders from PLC, updates DB with lifecycle timestamps.
    Returns the payload dict (caller serializes with jsonify / cache).
    Must run under _ORDERS_SNAPSHOT_LOCK when coordinated with HTTP cache.
    """
    from models.orders import IntakeOrder, OutloadingOrder, BulkLineOrder, PTLineOrder
    
    payload: Dict[str, Any] = {}
    mineral_orders = []  # Initialize mineral_orders at the beginning
    legacy_mineral_orders = []  # Initialize legacy_mineral_orders
    queue_contexts: List[Dict[str, Any]] = []  # per-line status for the order queue dispatcher

    # DB1 Intake (Regular intake lines 1 & 2, plus legacy mineral orders)
    m1 = load_map_from_pg(1); b1 = read_db_bytes(1, _needed_bytes(m1))
    if b1:
        l1 = render_lines(b1, m1["line_tags"])
        queue_contexts.append(_queue_ctx("intake", 1, 1, l1))
        queue_contexts.append(_queue_ctx("intake", 1, 2, l1))
        # Check all lines for intake orders
        all_intake = [r for r in (_intake_row(l1, k) for k in (1,2)) if r]
        _vlog(f"[DEBUG] All intake orders from DB1: {all_intake}")
        
        # Separate regular intake from mineral orders (by destination silos)
        regular_intake = []
        legacy_mineral_orders = []
        
        for order in all_intake:
            dest1 = order.get('dest1', 0)
            dest2 = order.get('dest2', 0)
            
            # Check if either destination is a mineral silo (401-408)
            is_mineral = (401 <= dest1 <= 408) or (401 <= dest2 <= 408)
            
            if is_mineral:
                _vlog(f"[DEBUG] Found legacy mineral order in DB1: {order}")
                legacy_mineral_orders.append(order)
            else:
                regular_intake.append(order)
        
        payload["intake"] = regular_intake
        _vlog(f"[DEBUG] Regular intake orders: {len(regular_intake)}")
        _vlog(f"[DEBUG] Legacy mineral orders from DB1: {len(legacy_mineral_orders)}")

    # DB3 Mineral Intake
    db3_mineral_orders = []
    m3 = load_map_from_pg(3); b3 = read_db_bytes(3, _needed_bytes(m3))
    if b3:
        l3 = render_lines(b3, m3["line_tags"])
        queue_contexts.append(_queue_ctx("mineral", 3, 3, l3))
        # Check line 3 for mineral orders (mineral orders use line 3, not line 1)
        db3_mineral_orders = [r for r in (_intake_row(l3, k) for k in (3,)) if r]
        _vlog(f"[DEBUG] Mineral orders from DB3 (line 3): {db3_mineral_orders}")
    else:
        _vlog(f"[DEBUG] DB3 not available or empty")

    # Combine legacy mineral orders from DB1 with new mineral orders from DB3
    mineral_orders.extend(db3_mineral_orders)
    mineral_orders.extend(legacy_mineral_orders)
    
    # Set the mineral orders
    payload["mineral"] = mineral_orders
    _vlog(f"[DEBUG] Final mineral orders count: {len(mineral_orders)} (DB3: {len(db3_mineral_orders)}, Legacy: {len(legacy_mineral_orders)})")

    # DB2 Outloading
    m2 = load_map_from_pg(2); b2 = read_db_bytes(2, _needed_bytes(m2))
    if b2:
        l2 = render_lines(b2, m2["line_tags"])
        for _ol in (1, 2, 3):
            queue_contexts.append(_queue_ctx("outloading", 2, _ol, l2))
        outloading_raw = [r for r in (_intake_row(l2, k) for k in (1,2,3)) if r]
        payload["outloading"] = outloading_raw
        _vlog(f"[DEBUG] DB2 Outloading: Found {len(outloading_raw)} outloading orders")
        for i, order in enumerate(outloading_raw):
            _vlog(f"[DEBUG] DB2 Outloading order {i+1}: badge_no={order.get('badge_no')}, status={order.get('status_word', {}).get('code')}")
    else:
        _vlog(f"[DEBUG] DB2 not available or empty")

    # DB4 Bulk/Pit
    m4 = load_map_from_pg(4); b4 = read_db_bytes(4, _needed_bytes(m4))
    if b4:
        l4 = render_lines(b4, m4["line_tags"])
        queue_contexts.append(_queue_ctx("bulk", 4, 0, l4))
        queue_contexts.append(_queue_ctx("pit", 4, 0, l4))
        payload["bulk"] = {
            "line": "Bulk",
            "source_silo": _nz(l4,"BulkLine_Source_Silo"),
            "dest1": _nz(l4,"BulkLine_DEST_1"),
            "dest2": _nz(l4,"BulkLine_DEST_2"),
            "cc25_sel": _nz(l4,"BulkLine_CC25_Sel"),
            "declared_qty_kg": _nz(l4,"BulkLine_Weight_Quantity"),
            "scale_sel": _nz(l4,"BulkLine_Scale_Selection"),
            "status_word": {
                "code": _nz(l4,"BulkLine_Status",0),
                "label": STATUS_MAP.get(_nz(l4,"BulkLine_Status",0), {"label": f"Code {_nz(l4,'BulkLine_Status',0)}"}).get("label"),
                "kind": STATUS_MAP.get(_nz(l4,"BulkLine_Status",0), {"kind": "inactive"}).get("kind"),
            },
            "active": {
                "source_silo": _nz(l4,"ActiveBulk_Source_Silo"),
                "dest1": _nz(l4,"ActiveBulk_DEST_1"),
                "dest2": _nz(l4,"ActiveBulk_DEST_2"),
                "cc25_sel": _nz(l4,"ActiveBulk_CC25_Sel"),
                "qty_kg": _nz(l4,"ActiveBulk_weightQuant"),
                "scale_sel": _nz(l4,"ActiveBulk_ScaleSelect"),
            }
        }
        payload["pit"] = {
            "line": "Pit",
            "pit_no": _nz(l4,"PitLine_Pit_Number"),
            "raw_code": _nz(l4,"PitLine_RawMaterialCode"),
            "dest1": _nz(l4,"PitLine_DEST_1"),
            "dest2": _nz(l4,"PitLine_DEST_2"),
            "declared_qty_kg": _nz(l4,"PitLine_Weight_Quantity"),
            "scale_sel": _nz(l4,"PitLine_Scale_Selection"),
            "status_word": {
                "code": _nz(l4,"PitLine_Status",0),
                "label": STATUS_MAP.get(_nz(l4,"PitLine_Status",0), {"label": f"Code {_nz(l4,'PitLine_Status',0)}"}).get("label"),
                "kind": STATUS_MAP.get(_nz(l4,"PitLine_Status",0), {"kind": "inactive"}).get("kind"),
            },
            "active": {
                "pit_no": _nz(l4,"ActivePit_Pit_Number"),
                "raw_code": _nz(l4,"ActivePit_RawMaterialCod"),
                "dest1": _nz(l4,"ActivePit_DEST_1"),
                "dest2": _nz(l4,"ActivePit_DEST_2"),
                "qty_kg": _nz(l4,"ActivePit_Weight_Quant"),
                "scale_sel": _nz(l4,"ActivePit_Scale_Select"),
            }
        }

    # 🔹 Update database with lifecycle tracking
    try:
        # Intake orders
        for intake in payload.get("intake", []):
            handle_order_status(intake, IntakeOrder, "intake")

        # Outloading orders
        outloading_orders = payload.get("outloading", [])
        _vlog(f"[DEBUG] Processing {len(outloading_orders)} outloading orders")
        for i, outloading in enumerate(outloading_orders):
            _vlog(f"[DEBUG] Outloading order {i+1}: {outloading}")
            handle_order_status(outloading, OutloadingOrder, "outloading")

        # Bulk order
        bulk = payload.get("bulk")
        if bulk:
            handle_order_status(bulk, BulkLineOrder, "bulk")

        # Pit order
        pit = payload.get("pit")
        if pit:
            handle_order_status(pit, PTLineOrder, "pit")

        # Mineral intake (line 3 in DB3)
        for mineral in payload.get("mineral", []):
            handle_order_status(mineral, IntakeOrder, "intake")

        _vlog(f"[DEBUG] Successfully updated database with lifecycle tracking")
    except Exception as e:
        print(f"[ERROR] Failed to update database with lifecycle tracking: {e}")

    # 🔹 Live order queue: dispatch next waiting order to any Idle line
    try:
        process_order_queue(queue_contexts)
    except Exception as e:
        print(f"[ERROR] Order queue processing failed: {e}")

    return payload


def fetch_plant_orders_snapshot() -> Dict[str, Any]:
    """
    PLC read + lifecycle under lock; refreshes snapshot used by HTTP when broadcast is active.
    """
    global _LAST_ORDERS_PAYLOAD, _LAST_ORDERS_TS

    with _ORDERS_SNAPSHOT_LOCK:
        payload = _execute_plant_orders()
        _LAST_ORDERS_PAYLOAD = copy.deepcopy(payload)
        _LAST_ORDERS_TS = time.time()
        return copy.deepcopy(payload)


# ─────────── Always-on queue dispatch (independent of the UI broadcast) ───────────
# The dispatcher must keep running even when nobody has the Orders page open / the
# websocket broadcast is stopped. This cycle is driven by the background scheduler
# (see scheduler.start_queue_dispatcher) so queued orders auto-start after restarts
# and regardless of the UI. A Postgres advisory lock (opt-in) ensures only one
# worker acts per cycle in multi-worker deployments.
_QUEUE_MULTIWORKER_LOCK = os.getenv("QUEUE_MULTIWORKER_LOCK", "0").lower() in ("1", "true", "yes")
_QUEUE_ADVISORY_LOCK_KEY = int(os.getenv("QUEUE_ADVISORY_LOCK_KEY", "728312001"))


def _acquire_dispatch_lock():
    """Try to take the cross-process advisory lock.

    Returns the raw connection holding the lock, the sentinel "NO_PG" when the
    advisory lock isn't available (so we still run single-process), or None when
    another worker currently holds it (so this cycle should be skipped).
    """
    try:
        raw = db.engine.raw_connection()
        cur = raw.cursor()
        cur.execute("SELECT pg_try_advisory_lock(%s)", (_QUEUE_ADVISORY_LOCK_KEY,))
        got = cur.fetchone()[0]
        cur.close()
        if got:
            return raw
        raw.close()
        return None
    except Exception as e:
        print(f"[QUEUE] advisory lock unavailable ({e}); running without it")
        return "NO_PG"


def _release_dispatch_lock(raw) -> None:
    if raw in (None, "NO_PG"):
        return
    try:
        cur = raw.cursor()
        cur.execute("SELECT pg_advisory_unlock(%s)", (_QUEUE_ADVISORY_LOCK_KEY,))
        cur.close()
        raw.commit()
    except Exception:
        pass
    finally:
        try:
            raw.close()
        except Exception:
            pass


def run_queue_dispatch_cycle() -> None:
    """One always-on dispatch cycle: read the PLC and process the order queue.

    Safe to call from the background scheduler on an interval. It reuses the same
    snapshot path as the broadcast (so lifecycle + snapshot cache stay fresh), and
    is idempotent thanks to the in-process _QUEUE_LOCK and the optional PG lock.
    """
    if DEMO_MODE or not _snap7_loaded:
        return

    lock = _acquire_dispatch_lock() if _QUEUE_MULTIWORKER_LOCK else "NO_PG"
    if lock is None:
        return  # another worker owns this cycle

    try:
        fetch_plant_orders_snapshot()
    except Exception as e:
        print(f"[QUEUE] dispatch cycle failed: {e}")
    finally:
        _release_dispatch_lock(lock)


@plc_bp.route("/plant/orders")
def plant_orders():
    """HTTP: returns live plant orders; uses cache while PLC broadcast is active."""
    from flask import current_app, request

    global _LAST_ORDERS_PAYLOAD, _LAST_ORDERS_TS

    force_refresh = str(request.args.get("nocache", "")).lower() in ("1", "true", "yes")
    broadcast_active = bool(current_app.config.get("PLC_BROADCAST_ACTIVE", False))
    ttl = float(current_app.config.get("PLC_ORDERS_CACHE_TTL_SEC", 1.25))

    with _ORDERS_SNAPSHOT_LOCK:
        if (
            not force_refresh
            and broadcast_active
            and _LAST_ORDERS_PAYLOAD is not None
            and (time.time() - _LAST_ORDERS_TS) <= ttl
        ):
            return jsonify(copy.deepcopy(_LAST_ORDERS_PAYLOAD))
        payload = _execute_plant_orders()
        _LAST_ORDERS_PAYLOAD = copy.deepcopy(payload)
        _LAST_ORDERS_TS = time.time()
        return jsonify(payload)


def _resolve_target_for_order(order_ref: str, truck_id: int) -> Optional[Dict[str, int]]:
    """
    Return {"db": 1|2, "line": 1|2|3} for this order.
    Maps order_ref patterns to specific lines:
    - "Mineral Intake" -> DB3, line 3
    - "Intake Line 2" -> line 2  
    - "Intake Line 1" -> line 1
    - "Outloading Line X" -> line X
    """
    order_ref_lower = order_ref.lower()
    
    # --- Mineral Intake (DB3) ---
    if 'mineral' in order_ref_lower:
        return {"db": 3, "line": 3}  # Mineral intake should use DB3, line 3
    
    # --- Intake Line 2 ---
    if 'intake' in order_ref_lower and 'line 2' in order_ref_lower:
        return {"db": 1, "line": 2}
    
    # --- Intake Line 1 (default intake) ---
    if 'intake' in order_ref_lower:
        return {"db": 1, "line": 1}
    
    # --- Outloading Lines ---
    if 'outload' in order_ref_lower:
        if 'line 3' in order_ref_lower:
            return {"db": 2, "line": 3}
        elif 'line 2' in order_ref_lower:
            return {"db": 2, "line": 2}
        else:
            return {"db": 2, "line": 1}  # default outloading line
    
    # --- Fallback: try to find from database ---
    # Check intake orders
    rows = _app_rows("""
        SELECT line
        FROM public.intake_orders
        ORDER BY id DESC
        LIMIT 1
    """)
    if rows:
        line_val = rows[0].line
        if isinstance(line_val, str):
            line_s = line_val.lower()
            if "mineral" in line_s: 
                return {"db": 3, "line": 3}  # Mineral intake should use DB3, line 3
            elif "line-2" in line_s: line_no = 2
            else: line_no = 1
        else:
            line_no = int(line_val or 1)
        return {"db": 1, "line": line_no}

    # Check outloading orders
    rows = _app_rows("""
        SELECT line
        FROM public.outloading_orders
        ORDER BY id DESC
        LIMIT 1
    """)
    if rows:
        return {"db": 2, "line": int(rows[0].line or 1)}

    return None  # cannot resolve


# ───────────────────────── Write endpoints ──────────────────────
# ---- simple assign endpoint: only order_ref, rfid_number, truck_id ----
@plc_bp.route("/rfid/assign", methods=["POST"])
def assign_rfid_and_push():
    """
    Body:
    {
      "rfid_number": "3",
      "truck_id": 1,
      "order_ref": "INT-10023"
    }
    """
    if DEMO_MODE or not _snap7_loaded:
        return jsonify({"error": "snap7 missing or DEMO_MODE=true"}), 503

    data = request.get_json(force=True) or {}
    rfid  = str((data.get("rfid_number") or "")).strip()
    truck = data.get("truck_id")
    order = data.get("order_ref")

    if not rfid or not truck or not order:
        return jsonify({"error": "rfid_number, truck_id, order_ref are required"}), 400

    # 1) Resolve where to write (no 'area' in request)
    target = _resolve_target_for_order(order, int(truck))
    if not target:
        return jsonify({"error": "Cannot resolve DB/line for this order_ref/truck_id"}), 404

    db_no  = int(target["db"])    # 1 = intake, 2 = outloading
    line   = int(target["line"])

    # 2) RFID availability bookkeeping
    cfg = RFIDConfig.query.filter_by(rfid_number=rfid).first()
    if not cfg:
        cfg = RFIDConfig(rfid_number=rfid, rfid_used=False, rfid_linked_to_order=None)
        db.session.add(cfg)
        db.session.flush()

    if cfg.rfid_used and cfg.rfid_linked_to_order not in (None, order):
        return jsonify({"error": "RFID already in use"}), 409

    # 3) Write badge to PLC (auto-handle INT vs STRING by mapping type)
    m = load_map_from_pg(db_no)
    if not _find_tag(m, f"L{line}_BadgeNo"):
        return jsonify({"error": f"Tag L{line}_BadgeNo not mapped in DB{db_no}"}), 400

    st = _read_status(db_no, m, "intake" if db_no==1 else "outloading", line)

    # Allow dev force if not Idle (no area param required)
    force = _force_enabled(request)
    if (st is not None) and (st != 1) and not force:
        return jsonify({"error": f"Line {line} not Idle (status={st})"}), 409

    sent = False
    ack: Dict[str, Any] = {}
    try:
        written = _write_tags(db_no, m, {f"L{line}_BadgeNo": rfid})
        sent = True
        ack = {"db": db_no, "line": line, "written": written, "status_was": st, "forced": (st != 1)}
    except Exception as e:
        ack = {"error": f"PLC write failed: {e}"}

    # 4) Don't store intake order in database - let handle_order_status store when status becomes 8
    db_order_id = None

    # 5) Log → RFIDLog, mark RFID used only if write succeeded
    rec = RFIDLog(
        rfid_number=rfid,
        truck_id=int(truck),
        order_ref=order,
        sent_to_plc=sent,
        plc_payload=ack,
    )
    db.session.add(rec)
    if sent:
        cfg.rfid_used = True
        cfg.rfid_linked_to_order = order
        db.session.commit()

    if not sent:
        return jsonify({"ok": False, **ack}), 400

    response_data = {
        "RFID Number": rfid,
        "Truck ID": int(truck),
        "Order Ref": order,
        "SentToPLC": sent
    }
    
    if db_order_id:
        response_data["DB Order ID"] = db_order_id
        response_data["note"] = "Order stored in database"

    return jsonify(response_data), 200
@plc_bp.route("/db/1/intake/line/<int:line>/write", methods=["POST"])
def write_intake(line: int):
    if DEMO_MODE or not _snap7_loaded:
        return jsonify({"error": "snap7 missing or DEMO_MODE=true"}), 503
    p = request.get_json(force=True) or {}
    m = load_map_from_pg(1)
    
    # Read status for information only (no blocking)
    st = _read_status(1, m, "intake", line)
    
    # Check silo availability (optional safety check)
    msg = _check_silos_allowed([int(p.get("dest1") or 0), int(p.get("dest2") or 0)])
    if msg: return jsonify({"error": msg}), 422
    
    kvs = {
        f"L{line}_BadgeNo":               p.get("badge_no"),
        f"L{line}_SourceRawMaterialCode": p.get("material_code"),
        f"L{line}_DeclaredQuantity_KG":   p.get("declared_qty_kg"),
        f"L{line}_DestinationSilo1":      p.get("dest1"),
        f"L{line}_DestinationSilo2":      p.get("dest2"),
    }
    
    plc_success = False
    db_success = False
    db_order_id = None
    
    try:
        # Write to PLC
        written = _write_tags(1, m, kvs)
        plc_success = True
        
        # Store in database
        from models.orders import IntakeOrder
        from datetime import datetime
        
        # Convert declared_qty_kg to int if it's a float
        declared_qty = p.get("declared_qty_kg")
        if isinstance(declared_qty, float):
            declared_qty = int(declared_qty)
        
        intake_order = IntakeOrder(
            badge_no=str(p.get("badge_no") or ""),
            source_material_code=str(p.get("material_code") or ""),
            declared_quantity_kg=declared_qty or 0,
            destination_silo1=str(p.get("dest1") or ""),
            destination_silo2=str(p.get("dest2") or ""),
            rfid_badge_reading=str(p.get("badge_no") or ""),  # Use badge_no as rfid_badge_reading
            active_badge=str(p.get("badge_no") or ""),        # Use badge_no as active_badge
            active_destination=str(p.get("dest1") or ""),     # Use dest1 as active_destination
            status_word=str(st or 1),                         # Use current status
            line=str(line)
        )
        
        # Don't store in database immediately - let handle_order_status store when status becomes 8
        db_success = True  # Consider it successful since PLC write succeeded
        db_order_id = None  # No database ID since we're not storing yet
        
        return jsonify({
            "ok": True, 
            "written": written, 
            "status_was": st, 
            "note": "Data written to PLC and stored in database",
            "plc_success": plc_success,
            "db_success": db_success,
            "db_order_id": db_order_id
        })
    except Exception as e:
        # If PLC write succeeded but DB failed, still return success for PLC
        if plc_success:
            return jsonify({
                "ok": True, 
                "written": written, 
                "status_was": st, 
                "note": "Data written to PLC but failed to store in database",
                "plc_success": plc_success,
                "db_success": db_success,
                "db_error": str(e)
            })
        else:
            return jsonify({"error": str(e)}), 400

@plc_bp.route("/db/3/mineral/line/<int:line>/write", methods=["POST"])
def write_mineral(line: int):
    """Write mineral order to DB3, line 3"""
    if DEMO_MODE or not _snap7_loaded:
        return jsonify({"error": "snap7 missing or DEMO_MODE=true"}), 503
    
    p = request.get_json(force=True) or {}
    
    # Validate mineral destinations (401-408)
    dest1 = p.get("dest1", 0)
    dest2 = p.get("dest2", 0)
    
    if not ((401 <= dest1 <= 408) or (401 <= dest2 <= 408)):
        return jsonify({
            "error": "Mineral orders must have destinations in range 401-408",
            "provided_destinations": {"dest1": dest1, "dest2": dest2},
            "valid_range": "401-408"
        }), 400
    
    m = load_map_from_pg(3)
    st = _read_status(3, m, "intake", line)
    
    # Allow dev force if not Idle
    force = _force_enabled(request)
    if (st is not None) and (st != 1) and not force:
        return jsonify({"error": f"Line {line} not Idle (status={st}). Use ?force=true to override."}), 409
    
    # Check silos if enabled
    if CHECK_SILOS:
        silo_check = _check_silos_allowed([dest1, dest2])
        if silo_check:
            return jsonify({"error": silo_check}), 422
    
    kvs = {
        f"L{line}_BadgeNo":               p.get("badge_no"),
        f"L{line}_SourceRawMaterialCode": p.get("material_code"),
        f"L{line}_DeclaredQuantity_KG":   p.get("declared_qty_kg"),
        f"L{line}_DestinationSilo1":      p.get("dest1"),
        f"L{line}_DestinationSilo2":      p.get("dest2"),
    }
    
    try:
        written = _write_tags(3, m, kvs)
        return jsonify({"ok": True, "written": written, "status_was": st})
    except Exception as e:
        return jsonify({"error": str(e)}), 400

@plc_bp.route("/db/2/outloading/line/<int:line>/write", methods=["POST"])
def write_outloading(line: int):
    if DEMO_MODE or not _snap7_loaded:
        return jsonify({"error": "snap7 missing or DEMO_MODE=true"}), 503
    p = request.get_json(force=True) or {}
    m = load_map_from_pg(2)
    
    # Read status for information only (no blocking)
    st = _read_status(2, m, "outloading", line)
    
    # Check silo availability (optional safety check)
    msg = _check_silos_allowed([int(p.get("dest1") or 0), int(p.get("dest2") or 0)])
    if msg: return jsonify({"error": msg}), 422
    
    kvs = {
        f"L{line}_BadgeNo":               p.get("badge_no"),
        f"L{line}_SourceRawMaterialCode": p.get("material_code"),
        f"L{line}_DeclaredQuantity_KG":   p.get("declared_qty_kg"),
        f"L{line}_DestinationSilo1":      p.get("dest1"),
        f"L{line}_DestinationSilo2":      p.get("dest2"),
        f"L{line}_DEST_SEL":              p.get("dest_sel", 0),  # Default to 0 (BULK) if not provided
    }
    
    plc_success = False
    db_success = False
    db_order_id = None
    
    try:
        # Write to PLC
        written = _write_tags(2, m, kvs)
        plc_success = True
        
        # Store in database
        from models.orders import OutloadingOrder
        from datetime import datetime
        
        # Convert declared_qty_kg to int if it's a float
        declared_qty = p.get("declared_qty_kg")
        if isinstance(declared_qty, float):
            declared_qty = int(declared_qty)
        
        outloading_order = OutloadingOrder(
            badge_no=str(p.get("badge_no") or ""),
            source_material_code=str(p.get("material_code") or ""),
            rfid_set=str(p.get("badge_no") or ""),              # Use badge_no as rfid_set
            declared_quantity_kg=declared_qty or 0,
            destination_silo1=str(p.get("dest1") or ""),
            destination_silo2=str(p.get("dest2") or ""),
            rfid_badge_reading=str(p.get("badge_no") or ""),    # Use badge_no as rfid_badge_reading
            active_badge=str(p.get("badge_no") or ""),          # Use badge_no as active_badge
            active_destination=str(p.get("dest1") or ""),       # Use dest1 as active_destination
            status_word=str(st or 1),                           # Use current status
            activ_dest_set=str(p.get("dest_sel") or p.get("dest1") or ""),  # Use dest_sel or dest1
            line=str(line)                                      # Add line field
        )
        
        # Don't store in database immediately - let handle_order_status store when status becomes 8
        db_success = True  # Consider it successful since PLC write succeeded
        db_order_id = None  # No database ID since we're not storing yet
        
        return jsonify({
            "ok": True, 
            "written": written, 
            "status_was": st, 
            "note": "Data written to PLC and stored in database",
            "plc_success": plc_success,
            "db_success": db_success,
            "db_order_id": db_order_id
        })
    except Exception as e:
        # If PLC write succeeded but DB failed, still return success for PLC
        if plc_success:
            return jsonify({
                "ok": True, 
                "written": written, 
                "status_was": st, 
                "note": "Data written to PLC but failed to store in database",
                "plc_success": plc_success,
                "db_success": db_success,
                "db_error": str(e)
            })
        else:
            return jsonify({"error": str(e)}), 400

@plc_bp.route("/db/4/bulk/write", methods=["POST"])
def write_bulk():
    if DEMO_MODE or not _snap7_loaded:
        return jsonify({"error": "snap7 missing or DEMO_MODE=true"}), 503
    p = request.get_json(force=True) or {}
    m = load_map_from_pg(4)
    
    # Read status for information only (no blocking)
    st = _read_status(4, m, "bulk", None)
    
    # Check silo availability (optional safety check)
    msg = _check_silos_allowed([int(p.get("source_silo") or 0), int(p.get("dest1") or 0), int(p.get("dest2") or 0)])
    if msg: return jsonify({"error": msg}), 422
    
    kvs = {
        "BulkLine_Source_Silo":     p.get("source_silo"),
        "BulkLine_DEST_1":          p.get("dest1"),
        "BulkLine_DEST_2":          p.get("dest2"),
        "BulkLine_CC25_Sel":        p.get("cc25_sel"),
        "BulkLine_Weight_Quantity": p.get("declared_qty_kg"),
        "BulkLine_Scale_Selection": p.get("scale_sel"),
    }
    
    plc_success = False
    db_success = False
    db_order_id = None
    
    try:
        # Write to PLC
        written = _write_tags(4, m, kvs)
        plc_success = True
        
        # Store in database
        from models.orders import BulkLineOrder
        from datetime import datetime
        
        # Convert declared_qty_kg to float if it's an int
        declared_qty = p.get("declared_qty_kg")
        if isinstance(declared_qty, int):
            declared_qty = float(declared_qty)
        
        bulk_order = BulkLineOrder(
            source_silo=str(p.get("source_silo") or ""),
            destination_silo1=str(p.get("dest1") or ""),
            destination_silo2=str(p.get("dest2") or ""),
            cc25_sel=str(p.get("cc25_sel") or ""),
            declared_quantity_kg=declared_qty or 0.0,
            scale_sel=str(p.get("scale_sel") or ""),
            status_word=str(st or 1),
            created_at=datetime.now(),
            updated_at=datetime.now(),
            is_complete=False
        )
        
        # Don't store in database immediately - let handle_order_status store when status becomes 8
        db_success = True  # Consider it successful since PLC write succeeded
        db_order_id = None  # No database ID since we're not storing yet
        
        return jsonify({
            "ok": True, 
            "written": written, 
            "status_was": st, 
            "note": "Data written to PLC and stored in database",
            "plc_success": plc_success,
            "db_success": db_success,
            "db_order_id": db_order_id
        })
    except Exception as e:
        # If PLC write succeeded but DB failed, still return success for PLC
        if plc_success:
            return jsonify({
                "ok": True, 
                "written": written, 
                "status_was": st, 
                "note": "Data written to PLC but failed to store in database",
                "plc_success": plc_success,
                "db_success": db_success,
                "db_error": str(e)
            })
        else:
            return jsonify({"error": str(e)}), 400

@plc_bp.route("/db/4/pit/write", methods=["POST"])
def write_pit():
    if DEMO_MODE or not _snap7_loaded:
        return jsonify({"error": "snap7 missing or DEMO_MODE=true"}), 503
    p = request.get_json(force=True) or {}
    m = load_map_from_pg(4)
    
    # Read status for information only (no blocking)
    st = _read_status(4, m, "pit", None)
    
    # Check silo availability (optional safety check)
    msg = _check_silos_allowed([int(p.get("dest1") or 0), int(p.get("dest2") or 0)])
    if msg: return jsonify({"error": msg}), 422
    
    kvs = {
        "PitLine_Pit_Number":      p.get("pit_no"),
        "PitLine_RawMaterialCode": p.get("raw_code"),
        "PitLine_DEST_1":          p.get("dest1"),
        "PitLine_DEST_2":          p.get("dest2"),
        "PitLine_Weight_Quantity": p.get("declared_qty_kg"),
        "PitLine_Scale_Selection": p.get("scale_sel"),
    }
    
    plc_success = False
    db_success = False
    db_order_id = None
    
    try:
        # Write to PLC
        written = _write_tags(4, m, kvs)
        plc_success = True
        
        # Store in database
        from models.orders import PTLineOrder
        from datetime import datetime
        
        # Convert declared_qty_kg to float if it's an int
        declared_qty = p.get("declared_qty_kg")
        if isinstance(declared_qty, int):
            declared_qty = float(declared_qty)
        
        pt_order = PTLineOrder(
            pit_no=str(p.get("pit_no") or ""),
            raw_code=str(p.get("raw_code") or ""),
            destination_silo1=str(p.get("dest1") or ""),
            destination_silo2=str(p.get("dest2") or ""),
            declared_quantity_kg=declared_qty or 0.0,
            scale_sel=str(p.get("scale_sel") or ""),
            status_word=str(st or 1),
            created_at=datetime.now(),
            updated_at=datetime.now(),
            is_complete=False
        )
        
        # Don't store in database immediately - let handle_order_status store when status becomes 8
        db_success = True  # Consider it successful since PLC write succeeded
        db_order_id = None  # No database ID since we're not storing yet
        
        return jsonify({
            "ok": True, 
            "written": written, 
            "status_was": st, 
            "note": "Data written to PLC and stored in database",
            "plc_success": plc_success,
            "db_success": db_success,
            "db_order_id": db_order_id
        })
    except Exception as e:
        # If PLC write succeeded but DB failed, still return success for PLC
        if plc_success:
            return jsonify({
                "ok": True, 
                "written": written, 
                "status_was": st, 
                "note": "Data written to PLC but failed to store in database",
                "plc_success": plc_success,
                "db_success": db_success,
                "db_error": str(e)
            })
        else:
            return jsonify({"error": str(e)}), 400

# ─────────────── Persist silos (PLC DB3) → app DB tables ───────────────
def persist_silos_from_plc(db_no: int = 3, qty_by_silo: Optional[Dict[int, float]] = None) -> Dict[str, Any]:
    """
    Reads silos from PLC and upserts into public.silo_status.
    qty_by_silo: optional pre-fetched DB5 quantities keyed by silo_no.
    """
    m = load_map_from_pg(db_no)
    b = read_db_bytes(db_no, _needed_bytes(m))
    if not b:
        return {"read": 0, "upserts": 0, "error": "PLC unreachable or DB absent"}

    if qty_by_silo is None:
        qty_by_silo = fetch_silo_qty_from_plc()

    rows = render_silos(b, m["silo_meta"], m["hl_map"])
    upserts = 0
    for r in rows:
        try:
            silo_no = int(str(r["bin_name"]).split()[-1])
        except Exception:
            continue

        mat_code = r.get("material_code") or ""
        mat_name = r.get("material_name") or ""
        hl       = bool(r.get("hl_active"))
        lock     = bool(r.get("lock_active"))
        qty      = qty_by_silo.get(silo_no)

        _app_exec("""
            INSERT INTO public.silo_status
                (silo_no, db_no, material_code, material_name, hl_active, lock_active, quantity_kg, updated_at)
            VALUES
                (%s, %s, %s, %s, %s, %s, %s, now())
            ON CONFLICT (silo_no) DO UPDATE SET
                db_no         = EXCLUDED.db_no,
                material_code = EXCLUDED.material_code,
                material_name = EXCLUDED.material_name,
                hl_active     = EXCLUDED.hl_active,
                lock_active   = EXCLUDED.lock_active,
                quantity_kg   = COALESCE(EXCLUDED.quantity_kg, public.silo_status.quantity_kg),
                updated_at    = now();
        """, (silo_no, db_no, mat_code, mat_name, hl, lock, qty))
        upserts += 1

    return {"read": len(rows), "upserts": upserts}

# ─────────────── Admin endpoints for persisting silos ───────────────
@plc_bp.route("/silos/sync", methods=["POST"])
def silos_sync_once():
    """One-shot: read all DBs (DB1, DB2, DB3) and upsert into public.silo_status."""
    results = {}
    total_read = 0
    total_upserts = 0
    
    qty_by_silo = fetch_silo_qty_from_plc()
    qty_upserts = 0
    if qty_by_silo:
        from routes.silos_sink import persist_silo_qty_batch
        qty_upserts = persist_silo_qty_batch(qty_by_silo)
    results["db5_qty"] = {
        "read": len(qty_by_silo),
        "upserts": qty_upserts,
        "error": None if qty_by_silo or DEMO_MODE else "PLC unreachable or DB5 absent",
    }

    # Sync all databases
    for db_no in [1, 2, 3]:
        try:
            res = persist_silos_from_plc(db_no=db_no, qty_by_silo=qty_by_silo)
            results[f"db{db_no}"] = res
            if not res.get("error"):
                total_read += res.get("read", 0)
                total_upserts += res.get("upserts", 0)
        except Exception as e:
            results[f"db{db_no}"] = {"error": str(e)}
    
    # Check if any sync was successful
    has_errors = any(res.get("error") for res in results.values())
    has_success = any(not res.get("error") for res in results.values())
    
    # Return 200 if at least one database synced successfully, 503 only if all failed
    status = 200 if has_success else 503
    
    return jsonify({
        "total_read": total_read,
        "total_upserts": total_upserts,
        "results": results,
        "has_errors": has_errors,
        "has_success": has_success
    }), status

# ───────────────── Frontend endpoints (database-backed) ─────────────────
@plc_bp.route("/silos", methods=["GET"])
def silos_from_db_under_plc_prefix():
    """DB-backed snapshot; merges live DB5 qty when PLC is reachable."""
    rows = _app_rows("""
        SELECT silo_no, db_no, material_code, material_name, hl_active, lock_active, quantity_kg, updated_at
        FROM public.silo_status
        ORDER BY silo_no
    """)
    qty_live = fetch_silo_qty_from_plc()
    out = []
    for r in rows:
        silo_no = int(r.silo_no)
        qty = _resolve_silo_qty(silo_no, qty_live or None, r.quantity_kg)
        out.append({
            "siloNo":       silo_no,
            "dbNo":         int(r.db_no) if r.db_no is not None else None,
            "binName":      f"Silo {silo_no}",
            "materialCode": r.material_code or "",
            "materialName": r.material_name or "",
            "hlActive":     bool(r.hl_active),
            "lockActive":   bool(r.lock_active),
            "quantityKg":   qty,
            "updatedAt":    r.updated_at.isoformat() if r.updated_at else None,
        })
    return jsonify(out)

# Keep a PLC-live variant under a different path to avoid collision
@plc_bp.route("/silos-plc", methods=["GET"])
def silos_direct_plc_default_db():
    return db_silos(DEFAULT_DB)

# Public endpoints the React page calls
@api_bp.route("/silos", methods=["GET"])
def api_silos():
    rows = _app_rows("""
        SELECT silo_no, db_no, material_code, material_name, hl_active, lock_active, quantity_kg, updated_at
        FROM public.silo_status
        ORDER BY silo_no
    """)
    qty_live = fetch_silo_qty_from_plc()
    return jsonify([
        {
            "siloNo":       int(r.silo_no),
            "dbNo":         int(r.db_no) if r.db_no is not None else None,
            "binName":      f"Silo {int(r.silo_no)}",
            "materialCode": r.material_code or "",
            "materialName": r.material_name or "",
            "hlActive":     bool(r.hl_active),
            "lockActive":   bool(r.lock_active),
            "quantityKg":   _resolve_silo_qty(int(r.silo_no), qty_live or None, r.quantity_kg),
            "updatedAt":    r.updated_at.isoformat() if r.updated_at else None,
        }
        for r in rows
    ])

@api_bp.route("/bin-materials", methods=["GET"])
def api_bin_materials():
    # Alias that returns exactly what your table renders
    rows = _app_rows("""
        SELECT silo_no, material_code, material_name, hl_active, lock_active
        FROM public.silo_status
        ORDER BY silo_no
    """)
    return jsonify([
        {
            "binName":      f"Silo {int(r.silo_no)}",
            "materialCode": r.material_code or "",
            "materialName": r.material_name or "",
            "hlActive":     bool(r.hl_active),
            "lockActive":   bool(r.lock_active),
        }
        for r in rows
    ])

# ─────────────── Back-compat shortcuts (PLC direct) ───────────────
# NOTE: "/health" is already registered above by plc_health() (live PLC health check).
# This one serves the DB snapshot instead, so it is registered under "/db-health" to
# avoid colliding with (and being shadowed by) the live PLC health endpoint.
@plc_bp.route("/db-health")
def health(): return db_health(DEFAULT_DB)

@plc_bp.route("/lines")
def lines():  return db_lines(DEFAULT_DB)

# NOTE: old '/api/plc/silos' used to return PLC live; it now serves DB snapshot.
# For PLC live, use '/api/plc/silos-plc' or '/api/plc/db/<n>/silos'.
@plc_bp.route("/orders")
def orders(): return db_orders(DEFAULT_DB)

@plc_bp.route("/test-simple", methods=["GET"])
def test_simple():
    """Simple test endpoint to verify route registration"""
    return jsonify({"ok": True, "message": "Simple test endpoint is working!"})

def get_mineral_orders():
    """Get all mineral orders from DB3, line 3"""
    try:
        # Get mineral orders from DB3, line 3
        m3 = load_map_from_pg(3)
        b3 = read_db_bytes(3, _needed_bytes(m3))
        
        mineral_orders = []
        if b3:
            l3 = render_lines(b3, m3["line_tags"])
            # Check line 3 for mineral orders
            mineral_orders = [r for r in (_intake_row(l3, k) for k in (3,)) if r]
            print(f"[DEBUG] Mineral orders from DB3 (line 3): {mineral_orders}")
        
        return jsonify({
            "ok": True,
            "order_type": "mineral",
            "database": "DB3",
            "line": 3,
            "orders": mineral_orders,
            "count": len(mineral_orders)
        })
        
    except Exception as e:
        return jsonify({"error": str(e)}), 500

def create_mineral_order():
    """
    Create mineral intake order specifically.
    Mineral orders always use DB3, line 3 and destinations 401-408.
    """
    if DEMO_MODE or not _snap7_loaded:
        return jsonify({"error": "snap7 missing or DEMO_MODE=true"}), 503
    
    data = request.get_json(force=True) or {}
    
    # Validate required fields
    required_fields = ["badge_no", "material_code", "declared_qty_kg", "dest1", "dest2"]
    for field in required_fields:
        if not data.get(field):
            return jsonify({"error": f"{field} is required for mineral orders"}), 400
    
    # Validate mineral destinations (401-408)
    dest1 = data.get("dest1", 0)
    dest2 = data.get("dest2", 0)
    
    if not ((401 <= dest1 <= 408) or (401 <= dest2 <= 408)):
        return jsonify({
            "error": "Mineral orders must have destinations in range 401-408",
            "provided_destinations": {"dest1": dest1, "dest2": dest2},
            "valid_range": "401-408"
        }), 400
    
    try:
        # Create mineral order with fixed parameters
        mineral_data = {
            "order_type": "intake",
            "line": 3,  # Always use line 3 for mineral orders
            "badge_no": data.get("badge_no"),
            "material_code": data.get("material_code"),
            "declared_qty_kg": data.get("declared_qty_kg"),
            "dest1": dest1,
            "dest2": dest2
        }
        
        print(f"[DEBUG] Creating mineral order: {mineral_data}")
        
        # Use the existing intake order function but force mineral behavior
        return _create_mineral_order_comprehensive(mineral_data)
        
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@plc_bp.route("/orders/mineral", methods=["GET", "POST"])
def mineral_orders():
    """Handle mineral orders - GET to retrieve, POST to create"""
    if request.method == "GET":
        return get_mineral_orders()
    elif request.method == "POST":
        return create_mineral_order()

@plc_bp.route("/orders/mineral/test", methods=["GET"])
def test_mineral_api():
    """Test endpoint to verify mineral API is working"""
    return jsonify({
        "ok": True,
        "message": "Mineral API is working!",
        "endpoints": {
            "GET /api/plc/orders/mineral": "Get mineral orders",
            "POST /api/plc/orders/mineral": "Create mineral order"
        }
    })

@plc_bp.route("/debug/routes", methods=["GET"])
def debug_routes():
    """Debug endpoint to list all registered routes"""
    routes = []
    for rule in current_app.url_map.iter_rules():
        routes.append({
            "rule": str(rule.rule),
            "methods": list(rule.methods),
            "endpoint": rule.endpoint
        })
    return jsonify({
        "ok": True,
        "message": "Registered routes",
        "routes": routes
    })

# ─────────────── Comprehensive Order Creation Endpoint ───────────────
@plc_bp.route("/orders/clear-legacy-mineral", methods=["POST"])
def clear_legacy_mineral_orders():
    """
    Clear legacy mineral orders from DB1 that are causing conflicts with regular intake orders.
    This specifically targets mineral orders that were created before the fix and are still in DB1.
    """
    if DEMO_MODE or not _snap7_loaded:
        return jsonify({"error": "snap7 missing or DEMO_MODE=true"}), 503
    
    try:
        cleared_tags = []
        
        # Clear line 1 in DB1 to remove any legacy mineral orders
        cleared_db1_l1 = _clear_plc_tags(1, 1)
        cleared_tags.extend([f"DB1_L1_{tag}" for tag in cleared_db1_l1])
        
        return jsonify({
            "ok": True,
            "message": "Cleared legacy mineral orders from DB1",
            "cleared_tags": cleared_tags,
            "summary": {
                "db1_line1_cleared": len(cleared_db1_l1)
            }
        })
        
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@plc_bp.route("/orders/clear-conflicts", methods=["POST"])
def clear_order_conflicts():
    """
    Clear conflicting orders between mineral and regular intake orders.
    This helps resolve issues where both order types were using the same PLC tags.
    """
    if DEMO_MODE or not _snap7_loaded:
        return jsonify({"error": "snap7 missing or DEMO_MODE=true"}), 503
    
    try:
        cleared_tags = []
        
        # Clear line 1 in DB1 (regular intake) to remove any mineral orders that were incorrectly placed there
        cleared_db1_l1 = _clear_plc_tags(1, 1)
        cleared_tags.extend([f"DB1_L1_{tag}" for tag in cleared_db1_l1])
        
        # Clear line 1 in DB3 (old mineral location) to remove any orders that were incorrectly placed there
        cleared_db3_l1 = _clear_plc_tags(3, 1)
        cleared_tags.extend([f"DB3_L1_{tag}" for tag in cleared_db3_l1])
        
        # Clear line 3 in DB3 (new mineral location) to ensure it's clean
        cleared_db3_l3 = _clear_plc_tags(3, 3)
        cleared_tags.extend([f"DB3_L3_{tag}" for tag in cleared_db3_l3])
        
        return jsonify({
            "ok": True,
            "message": "Cleared conflicting PLC tags",
            "cleared_tags": cleared_tags,
            "summary": {
                "db1_line1_cleared": len(cleared_db1_l1),
                "db3_line1_cleared": len(cleared_db3_l1),
                "db3_line3_cleared": len(cleared_db3_l3)
            }
        })
        
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@plc_bp.route("/orders/clear-mineral", methods=["POST"])
def clear_mineral_orders():
    """Clear mineral orders from DB3 line 3"""
    if DEMO_MODE or not _snap7_loaded:
        return jsonify({"error": "snap7 missing or DEMO_MODE=true"}), 503
    
    try:
        cleared_tags = _clear_plc_tags(3, 3)
        return jsonify({
            "ok": True,
            "message": "Cleared mineral orders from DB3 line 3",
            "cleared_tags": cleared_tags
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@plc_bp.route("/orders/enqueue", methods=["POST"])
def enqueue_order():
    """
    Add an order to the live queue as WAITING (does NOT write to the PLC).
    The dispatcher later writes it to the PLC when the line is Idle and the
    scanned RFID matches. Multiple orders can be queued per line.

    Body: order_type, line, rfid_number, badge_no, material_code, material_name,
          declared_qty_kg, dest1, dest2, dest_sel, source_silo, cc25_sel,
          scale_sel, pit_no, raw_code, truck_id, client_id
    """
    from sqlalchemy import func
    from models.order_queue import OrderQueue, QUEUE_WAITING

    data = request.get_json(force=True) or {}
    order_type = str(data.get("order_type") or "").lower()
    line = _q_int(data.get("line"), 0)
    rfid = str(data.get("rfid_number") or "").strip()

    dest1 = _q_int(data.get("dest1"))
    dest2 = _q_int(data.get("dest2"))

    # Resolve effective order type + PLC routing
    if order_type == "intake":
        is_mineral = (401 <= dest1 <= 408) or (401 <= dest2 <= 408) or line == 3 or bool(data.get("is_mineral"))
        if is_mineral:
            eff_type, db_no, line = "mineral", 3, 3
        else:
            eff_type, db_no = "intake", 1
    elif order_type == "mineral":
        eff_type, db_no, line = "mineral", 3, 3
    elif order_type == "outloading":
        eff_type, db_no = "outloading", 2
    elif order_type == "bulk":
        eff_type, db_no, line = "bulk", 4, 0
    elif order_type == "pit":
        eff_type, db_no, line = "pit", 4, 0
    else:
        return jsonify({"error": f"Unknown order_type: {order_type}"}), 400

    rfid_required = eff_type in ("intake", "mineral", "outloading")
    if rfid_required and not rfid:
        return jsonify({"error": "rfid_number is required for this order type"}), 400

    # RFID lock: a tag linked to an open order cannot be reused
    cfg = None
    if rfid:
        cfg = RFIDConfig.query.filter_by(rfid_number=rfid).first()
        if not cfg:
            cfg = RFIDConfig(rfid_number=rfid, rfid_used=False, rfid_linked_to_order=None)
            db.session.add(cfg)
            db.session.flush()
        if cfg.rfid_used:
            return jsonify({"error": "RFID already in use", "rfid_number": rfid}), 409

    # Next queue position for this line
    max_pos = (
        db.session.query(func.max(OrderQueue.queue_position))
        .filter(OrderQueue.order_type == eff_type,
                OrderQueue.line == line,
                OrderQueue.queue_status == QUEUE_WAITING)
        .scalar()
    )
    position = (max_pos or 0) + 1

    row = OrderQueue(
        order_type=eff_type,
        db_no=db_no,
        line=line,
        rfid_number=rfid or None,
        queue_status=QUEUE_WAITING,
        queue_position=position,
        badge_no=str(data.get("badge_no") or "") or None,
        material_code=str(data.get("material_code") or "") or None,
        material_name=str(data.get("material_name") or "") or None,
        declared_qty_kg=_q_float(data.get("declared_qty_kg")),
        dest1=str(data.get("dest1") or "") or None,
        dest2=str(data.get("dest2") or "") or None,
        dest_sel=str(data.get("dest_sel") or "") or None,
        source_silo=str(data.get("source_silo") or "") or None,
        cc25_sel=str(data.get("cc25_sel") or "") or None,
        scale_sel=str(data.get("scale_sel") or "") or None,
        pit_no=str(data.get("pit_no") or "") or None,
        raw_code=str(data.get("raw_code") or "") or None,
        truck_id=_q_int(data.get("truck_id")) or None,
        client_id=_q_int(data.get("client_id")) or None,
    )
    db.session.add(row)
    db.session.flush()

    if cfg is not None:
        cfg.rfid_used = True
        cfg.rfid_linked_to_order = f"QUEUE-{row.id}"

    if rfid and row.truck_id:
        try:
            db.session.add(RFIDLog(
                rfid_number=rfid,
                truck_id=row.truck_id,
                order_ref=f"QUEUE-{row.id}",
                sent_to_plc=False,
                plc_payload={"note": "enqueued", "order_type": eff_type, "line": line},
            ))
        except Exception:
            pass

    db.session.commit()
    return jsonify({"ok": True, "order": row.to_dict()}), 201


@plc_bp.route("/orders/queue", methods=["GET"])
def list_order_queue():
    """List queued orders. Query params: order_type, line, status, include_done."""
    from models.order_queue import OrderQueue, OPEN_STATUSES

    q = OrderQueue.query
    order_type = request.args.get("order_type")
    line = request.args.get("line")
    status = request.args.get("status")
    include_done = request.args.get("include_done", "").lower() in ("1", "true", "yes")

    if order_type:
        q = q.filter(OrderQueue.order_type == order_type.lower())
    if line is not None and line != "":
        q = q.filter(OrderQueue.line == _q_int(line))
    if status:
        q = q.filter(OrderQueue.queue_status == status.upper())
    elif not include_done:
        q = q.filter(OrderQueue.queue_status.in_(list(OPEN_STATUSES)))

    rows = q.order_by(OrderQueue.line.asc(),
                      OrderQueue.queue_position.asc(),
                      OrderQueue.created_at.asc()).all()
    return jsonify({"items": [r.to_dict() for r in rows], "total": len(rows)})


@plc_bp.route("/orders/queue/<int:queue_id>/start", methods=["POST"])
def start_queued_order(queue_id: int):
    """Manually dispatch a WAITING order to the PLC now (bypass the RFID scan).

    Guards against overwriting a running order: the PLC line must be Idle and no
    other queue order may be active on that line, unless ?force=true is passed.
    """
    from models.order_queue import OrderQueue, QUEUE_WAITING, QUEUE_DISPATCHED, ACTIVE_STATUSES

    if DEMO_MODE or not _snap7_loaded:
        return jsonify({"error": "snap7 missing or DEMO_MODE=true"}), 503

    row = OrderQueue.query.get(queue_id)
    if not row:
        return jsonify({"error": "Queue item not found"}), 404
    if row.queue_status != QUEUE_WAITING:
        return jsonify({"error": f"Only WAITING orders can be started (status={row.queue_status})"}), 409

    force = _force_enabled(request)

    with _QUEUE_LOCK:
        # Another queued order already occupying this line?
        active = (
            OrderQueue.query
            .filter(OrderQueue.order_type == row.order_type,
                    OrderQueue.line == row.line,
                    OrderQueue.queue_status.in_(list(ACTIVE_STATUSES)))
            .first()
        )
        if active and not force:
            return jsonify({"error": f"Line already has an active order (#{active.id}). Use ?force=true to override."}), 409

        m = load_map_from_pg(row.db_no)
        if row.order_type == "outloading":
            area, ln = "outloading", row.line
        elif row.order_type == "bulk":
            area, ln = "bulk", None
        elif row.order_type == "pit":
            area, ln = "pit", None
        else:
            area, ln = "intake", row.line

        st = _read_status(row.db_no, m, area, ln)
        if (st is not None) and (st != 1) and not force:
            return jsonify({"error": f"Line not Idle (status={st}). Use ?force=true to override."}), 409

        try:
            kvs = _order_kvs(row)
            _write_tags(row.db_no, m, kvs)
        except Exception as e:
            db.session.rollback()
            return jsonify({"error": f"PLC write failed: {e}"}), 400

        row.queue_status = QUEUE_DISPATCHED
        row.dispatched_at = datetime.now()
        db.session.commit()

    return jsonify({"ok": True, "order": row.to_dict()})


@plc_bp.route("/orders/queue/<int:queue_id>/cancel", methods=["POST"])
def cancel_queued_order(queue_id: int):
    """Cancel a WAITING or DISPATCHED (not yet started) order and release its RFID."""
    from models.order_queue import OrderQueue, QUEUE_WAITING, QUEUE_DISPATCHED, QUEUE_CANCELLED

    row = OrderQueue.query.get(queue_id)
    if not row:
        return jsonify({"error": "Queue item not found"}), 404

    if row.queue_status not in (QUEUE_WAITING, QUEUE_DISPATCHED):
        return jsonify({"error": f"Cannot cancel order in status {row.queue_status}"}), 409

    with _QUEUE_LOCK:
        # If already written to the PLC, clear the line's tags.
        if row.queue_status == QUEUE_DISPATCHED and row.order_type in ("intake", "mineral", "outloading"):
            try:
                _clear_plc_tags(row.db_no, row.line)
            except Exception as e:
                _vlog(f"[QUEUE] clear tags on cancel failed: {e}")

        row.queue_status = QUEUE_CANCELLED
        _release_rfid(row.rfid_number)
        db.session.commit()

    return jsonify({"ok": True, "order": row.to_dict()})


@plc_bp.route("/orders/create", methods=["POST"])
def create_order_comprehensive():
    """
    Create order in both PLC and database.
    Body should include:
    - order_type: "intake", "outloading", "bulk", or "pit"
    - line: line number (for intake/outloading)
    - All relevant order data
    """
    if DEMO_MODE or not _snap7_loaded:
        return jsonify({"error": "snap7 missing or DEMO_MODE=true"}), 503
    
    data = request.get_json(force=True) or {}
    order_type = data.get("order_type", "").lower()
    
    if not order_type:
        return jsonify({"error": "order_type is required"}), 400
    
    _stash_order_metadata(order_type, data)
    
    try:
        if order_type == "intake":
            line = data.get("line", 1)
            print(f"[DEBUG] create_order_comprehensive: order_type={order_type}, line={line}, data={data}")
            return _create_intake_order_comprehensive(line, data)
        elif order_type == "outloading":
            line = data.get("line", 1)
            return _create_outloading_order_comprehensive(line, data)
        elif order_type == "bulk":
            return _create_bulk_order_comprehensive(data)
        elif order_type == "pit":
            return _create_pit_order_comprehensive(data)
        else:
            return jsonify({"error": f"Unknown order_type: {order_type}"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500

def _create_mineral_order_comprehensive(data: dict):
    """Create mineral intake order in both PLC and database - always uses DB3, line 3"""
    from models.orders import IntakeOrder
    from datetime import datetime
    
    print(f"[DEBUG] _create_mineral_order_comprehensive called with data={data}")
    
    # Prepare PLC data with default values to prevent NoneType errors
    plc_data = {
        "badge_no": data.get("badge_no") or 0,
        "material_code": data.get("material_code") or "",
        "declared_qty_kg": data.get("declared_qty_kg") or 0,
        "dest1": data.get("dest1") or 0,
        "dest2": data.get("dest2") or 0
    }
    
    # Mineral orders always use DB3, line 3
    db_number = 3
    mineral_line = 3
    
    print(f"[DEBUG] Mineral order - Destinations: {plc_data.get('dest1')}, {plc_data.get('dest2')}, Using DB: {db_number}, Line: {mineral_line}")
    
    # Write to PLC
    m = load_map_from_pg(db_number)
    st = _read_status(db_number, m, "intake", mineral_line)
    
    kvs = {
        f"L{mineral_line}_BadgeNo":               plc_data.get("badge_no"),
        f"L{mineral_line}_SourceRawMaterialCode": plc_data.get("material_code"),
        f"L{mineral_line}_DeclaredQuantity_KG":   plc_data.get("declared_qty_kg"),
        f"L{mineral_line}_DestinationSilo1":      plc_data.get("dest1"),
        f"L{mineral_line}_DestinationSilo2":      plc_data.get("dest2"),
    }
    
    plc_success = False
    db_success = False
    db_order_id = None
    db_line_identifier = f"DB{db_number}_L{mineral_line}"
    
    try:
        written = _write_tags(db_number, m, kvs)
        plc_success = True
        
        # Don't store in database immediately - let handle_order_status store when status becomes 8
        db_success = True  # Consider it successful since PLC write succeeded
        db_order_id = None  # No database ID since we're not storing yet
        
        return jsonify({
            "ok": True,
            "order_type": "mineral",
            "line": 3,
            "is_mineral_order": True,
            "database_used": f"DB{db_number}",
            "db_line_identifier": db_line_identifier,
            "plc_success": plc_success,
            "db_success": db_success,
            "db_order_id": db_order_id,
            "written_tags": written,
            "status_was": st
        })
    except Exception as e:
        if plc_success:
            return jsonify({
                "ok": True,
                "order_type": "mineral",
                "line": 3,
                "is_mineral_order": True,
                "database_used": f"DB{db_number}",
                "db_line_identifier": db_line_identifier,
                "plc_success": plc_success,
                "db_success": db_success,
                "db_error": str(e),
                "written_tags": written,
                "status_was": st
            })
        else:
            raise e

def _create_intake_order_comprehensive(line: int, data: dict):
    """Create intake order in both PLC and database"""
    from models.orders import IntakeOrder
    from datetime import datetime
    
    print(f"[DEBUG] _create_intake_order_comprehensive called with line={line}, data={data}")
    
    # Prepare PLC data with default values to prevent NoneType errors
    plc_data = {
        "badge_no": data.get("badge_no") or 0,  # Use 0 for integer fields, not empty string
        "material_code": data.get("material_code") or "",
        "declared_qty_kg": data.get("declared_qty_kg") or 0,
        "dest1": data.get("dest1") or 0,
        "dest2": data.get("dest2") or 0
    }
    
    print(f"[DEBUG] plc_data prepared: {plc_data}")
    
    # Determine if this is a mineral order based on destination silos (401-408)
    dest1 = plc_data.get("dest1", 0)
    dest2 = plc_data.get("dest2", 0)
    is_mineral_order = (401 <= dest1 <= 408) or (401 <= dest2 <= 408)
    
    # Select the appropriate database and line: DB3, line 3 for mineral orders, DB1, line 1 for regular intake
    if is_mineral_order:
        db_number = 3
        mineral_line = 3  # Mineral orders should use line 3 (L3_BadgeNo, etc.)
    else:
        db_number = 1
        mineral_line = line  # Regular intake uses the provided line number
    
    print(f"[DEBUG] Intake order - Mineral: {is_mineral_order}, Destinations: {dest1}, {dest2}, Using DB: {db_number}, Line: {mineral_line}")
    
    # Write to PLC
    m = load_map_from_pg(db_number)
    st = _read_status(db_number, m, "intake", mineral_line)
    
    kvs = {
        f"L{mineral_line}_BadgeNo":               plc_data.get("badge_no"),
        f"L{mineral_line}_SourceRawMaterialCode": plc_data.get("material_code"),
        f"L{mineral_line}_DeclaredQuantity_KG":   plc_data.get("declared_qty_kg"),
        f"L{mineral_line}_DestinationSilo1":      plc_data.get("dest1"),
        f"L{mineral_line}_DestinationSilo2":      plc_data.get("dest2"),
    }
    
    plc_success = False
    db_success = False
    db_order_id = None
    db_line_identifier = f"DB{db_number}_L{mineral_line}"
    
    try:
        written = _write_tags(db_number, m, kvs)
        plc_success = True
        
        # Don't store in database immediately - let handle_order_status store when status becomes 8
        db_success = True  # Consider it successful since PLC write succeeded
        db_order_id = None  # No database ID since we're not storing yet
        
        return jsonify({
            "ok": True,
            "order_type": "intake",
            "line": line,
            "plc_line": mineral_line,
            "is_mineral_order": is_mineral_order,
            "database_used": f"DB{db_number}",
            "db_line_identifier": db_line_identifier,
            "plc_success": plc_success,
            "db_success": db_success,
            "db_order_id": db_order_id,
            "written_tags": written,
            "status_was": st
        })
    except Exception as e:
        if plc_success:
            return jsonify({
                "ok": True,
                "order_type": "intake",
                "line": line,
                "plc_line": mineral_line,
                "is_mineral_order": is_mineral_order,
                "database_used": f"DB{db_number}",
                "db_line_identifier": db_line_identifier,
                "plc_success": plc_success,
                "db_success": db_success,
                "db_error": str(e),
                "written_tags": written,
                "status_was": st
            })
        else:
            raise e

def _create_outloading_order_comprehensive(line: int, data: dict):
    """Create outloading order in both PLC and database"""
    from models.orders import OutloadingOrder
    from datetime import datetime
    
    # Write to PLC
    m = load_map_from_pg(2)
    st = _read_status(2, m, "outloading", line)
    
    kvs = {
        f"L{line}_BadgeNo":               data.get("badge_no") or "",
        f"L{line}_SourceRawMaterialCode": data.get("material_code") or "",
        f"L{line}_DeclaredQuantity_KG":   data.get("declared_qty_kg") or 0,
        f"L{line}_DestinationSilo1":      data.get("dest1") or 0,
        f"L{line}_DestinationSilo2":      data.get("dest2") or 0,
        f"L{line}_DEST_SEL":              data.get("dest_sel", 0),  # Default to 0 (BULK) if not provided
    }
    
    plc_success = False
    db_success = False
    db_order_id = None
    
    try:
        written = _write_tags(2, m, kvs)
        plc_success = True
        
        # Store in database
        declared_qty = data.get("declared_qty_kg")
        if isinstance(declared_qty, float):
            declared_qty = int(declared_qty)
        
        outloading_order = OutloadingOrder(
            badge_no=str(data.get("badge_no") or ""),
            source_material_code=str(data.get("material_code") or ""),
            rfid_set=str(data.get("badge_no") or ""),
            declared_quantity_kg=declared_qty or 0,
            destination_silo1=str(data.get("dest1") or ""),
            destination_silo2=str(data.get("dest2") or ""),
            rfid_badge_reading=str(data.get("badge_no") or ""),
            active_badge=str(data.get("badge_no") or ""),
            active_destination=str(data.get("dest1") or ""),
            status_word=str(st or 1),
            activ_dest_set=str(data.get("dest_sel") or data.get("dest1") or ""),
            line=str(line)                                      # Add line field
        )
        
        # Don't store in database immediately - let handle_order_status store when status becomes 8
        db_success = True  # Consider it successful since PLC write succeeded
        db_order_id = None  # No database ID since we're not storing yet
        
        return jsonify({
            "ok": True,
            "order_type": "outloading",
            "line": line,
            "plc_success": plc_success,
            "db_success": db_success,
            "db_order_id": db_order_id,
            "written_tags": written,
            "status_was": st
        })
    except Exception as e:
        if plc_success:
            return jsonify({
                "ok": True,
                "order_type": "outloading",
                "line": line,
                "plc_success": plc_success,
                "db_success": db_success,
                "db_error": str(e),
                "written_tags": written,
                "status_was": st
            })
        else:
            raise e

def _create_bulk_order_comprehensive(data: dict):
    """Create bulk order in both PLC and database"""
    from models.orders import BulkLineOrder
    from datetime import datetime
    
    # Write to PLC
    m = load_map_from_pg(4)
    st = _read_status(4, m, "bulk", None)
    
    kvs = {
        "BulkLine_Source_Silo":     data.get("source_silo") or 0,
        "BulkLine_DEST_1":          data.get("dest1") or 0,
        "BulkLine_DEST_2":          data.get("dest2") or 0,
        "BulkLine_CC25_Sel":        data.get("cc25_sel") or 0,
        "BulkLine_Weight_Quantity": data.get("declared_qty_kg") or 0,
        "BulkLine_Scale_Selection": data.get("scale_sel") or 0,
    }
    
    plc_success = False
    db_success = False
    db_order_id = None
    
    try:
        written = _write_tags(4, m, kvs)
        plc_success = True
        
        # Don't store in database immediately - let handle_order_status store when status becomes 8
        db_success = True  # Consider it successful since PLC write succeeded
        db_order_id = None  # No database ID since we're not storing yet
        
        return jsonify({
            "ok": True,
            "order_type": "bulk",
            "plc_success": plc_success,
            "db_success": db_success,
            "db_order_id": db_order_id,
            "written_tags": written,
            "status_was": st
        })
    except Exception as e:
        if plc_success:
            return jsonify({
                "ok": True,
                "order_type": "bulk",
                "plc_success": plc_success,
                "db_success": db_success,
                "db_error": str(e),
                "written_tags": written,
                "status_was": st
            })
        else:
            raise e

def _create_pit_order_comprehensive(data: dict):
    """Create pit order in both PLC and database"""
    from models.orders import PTLineOrder
    from datetime import datetime
    
    # Write to PLC
    m = load_map_from_pg(4)
    st = _read_status(4, m, "pit", None)
    
    kvs = {
        "PitLine_Pit_Number":      data.get("pit_no") or 0,
        "PitLine_RawMaterialCode": data.get("raw_code") or "",
        "PitLine_DEST_1":          data.get("dest1") or 0,
        "PitLine_DEST_2":          data.get("dest2") or 0,
        "PitLine_Weight_Quantity": data.get("declared_qty_kg") or 0,
        "PitLine_Scale_Selection": data.get("scale_sel") or 0,
    }
    
    plc_success = False
    db_success = False
    db_order_id = None
    
    try:
        written = _write_tags(4, m, kvs)
        plc_success = True
        
        # Don't store in database immediately - let handle_order_status store when status becomes 8
        db_success = True  # Consider it successful since PLC write succeeded
        db_order_id = None  # No database ID since we're not storing yet
        
        return jsonify({
            "ok": True,
            "order_type": "pit",
            "plc_success": plc_success,
            "db_success": db_success,
            "db_order_id": db_order_id,
            "written_tags": written,
            "status_was": st
        })
    except Exception as e:
        if plc_success:
            return jsonify({
                "ok": True,
                "order_type": "pit",
                "plc_success": plc_success,
                "db_success": db_success,
                "db_error": str(e),
                "written_tags": written,
                "status_was": st
            })
        else:
            raise e
