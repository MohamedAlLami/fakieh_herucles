"""Live weight readers for Baykon BX23 weighbridge scales (HTTP status.cgi)."""
from __future__ import annotations

import base64
import os
import re
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from typing import Any, Optional

# Scale 1 = entry (IN) @ .200, Scale 2 = exit (OUT) @ .220
SCALES: dict[int, dict[str, str]] = {
    1: {
        "name": "Scale 1",
        "role": "entry",
        "ip": "192.168.1.200",
        "mac": "44-6F-D8-20-13-85",
    },
    2: {
        "name": "Scale 2",
        "role": "exit",
        "ip": "192.168.1.220",
        "mac": "44:6F:D8:20:34:D1",
    },
}

HTTP_USER = "admin"
HTTP_PASS = ""
NBSP_RE = re.compile(r"(?:&#160;|&nbsp;|\xa0|\s)+")
NUM_RE = re.compile(r"([+-]?\d+(?:[.,]\d+)?)")


def get_scale(scale_id: int) -> Optional[dict[str, str]]:
    return SCALES.get(int(scale_id))


def _scale_base_url(scale_id: Optional[int], ip: str) -> str:
    """Base URL for a scale. BAYKON_SCALE1_URL / BAYKON_SCALE2_URL override it (testing)."""
    override = os.getenv(f"BAYKON_SCALE{scale_id}_URL", "").strip() if scale_id else ""
    return override.rstrip("/") if override else f"http://{ip}"


def _http_status(ip: str, timeout: float = 5.0, scale_id: Optional[int] = None) -> tuple[Optional[dict], str]:
    url = f"{_scale_base_url(scale_id, ip)}/status.cgi"
    token = base64.b64encode(f"{HTTP_USER}:{HTTP_PASS}".encode()).decode()
    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Basic {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}"
    except Exception as e:
        return None, f"HTTP error: {e}"

    try:
        text = raw.decode("utf-8", "replace")
        root = ET.fromstring(text)
    except ET.ParseError as e:
        return None, f"bad XML: {e}"

    fields = {child.tag: (child.text or "") for child in root}
    return fields, "ok"


def _parse_web_weight(fields: dict) -> tuple[Optional[float], bool, str, str]:
    lower = NBSP_RE.sub(" ", fields.get("lowerrow", "")).strip()
    m = NUM_RE.search(lower.replace(",", "."))
    if not m:
        return None, False, "kg", f"no number in lowerrow={lower!r}"
    weight = float(m.group(1))
    unit = (fields.get("kgunit") or fields.get("lbunit") or "").strip() or "kg"
    stable = fields.get("unstablesign", "1") != "1"
    mode = "NET" if fields.get("netsign") == "1" else "GROSS"
    return weight, stable, unit, mode


def read_live_weight(scale_id: int, timeout: float = 5.0) -> dict[str, Any]:
    """
    Read live weight from a Baykon scale.
    Returns a dict suitable for JSON: weight_kg, stable, unit, mode, ok, error, ...
    """
    meta = get_scale(scale_id)
    if not meta:
        return {
            "ok": False,
            "scale": scale_id,
            "error": f"Unknown scale id {scale_id} (use 1 or 2)",
            "weight_kg": None,
            "stable": False,
        }

    fields, detail = _http_status(meta["ip"], timeout=timeout, scale_id=int(scale_id))
    if fields is None:
        return {
            "ok": False,
            "scale": scale_id,
            "name": meta["name"],
            "role": meta["role"],
            "ip": meta["ip"],
            "mac": meta["mac"],
            "weight_kg": None,
            "stable": False,
            "error": detail,
        }

    weight, stable, unit, mode = _parse_web_weight(fields)
    if weight is None:
        return {
            "ok": False,
            "scale": scale_id,
            "name": meta["name"],
            "role": meta["role"],
            "ip": meta["ip"],
            "mac": meta["mac"],
            "weight_kg": None,
            "stable": False,
            "unit": unit,
            "mode": mode,
            "error": detail if isinstance(detail, str) and detail != "ok" else "Failed to parse weight",
        }

    return {
        "ok": True,
        "scale": scale_id,
        "name": meta["name"],
        "role": meta["role"],
        "ip": meta["ip"],
        "mac": meta["mac"],
        "weight_kg": weight,
        "stable": stable,
        "unit": unit,
        "mode": mode,
        "error": None,
    }
