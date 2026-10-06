"""Planetary K-index from NOAA's Space Weather Prediction Center.

https://www.swpc.noaa.gov/products/planetary-k-index
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

KP_URL = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json"


@dataclass
class KpReading:
    kp: float
    time: datetime  # start of the 3-hour interval (UTC)
    label: str

    def public(self) -> dict[str, Any]:
        return {"kp": self.kp, "time": self.time.isoformat().replace("+00:00", "Z"), "label": self.label}


def describe_kp(kp: float) -> str:
    """NOAA G-scale: Kp 5 = G1 (minor) … Kp 9 = G5 (extreme)."""
    for limit, label in ((9, "G5 extreme storm"), (8, "G4 severe storm"), (7, "G3 strong storm"), (6, "G2 moderate storm"), (5, "G1 minor storm"), (4, "Active"), (3, "Unsettled")):
        if kp >= limit:
            return label
    return "Quiet"


def _parse_time(v: Any) -> datetime | None:
    if not isinstance(v, str):
        return None
    s = v.strip().replace(" ", "T", 1)
    if not re.search(r"(Z|[+-]\d\d:?\d\d)$", s):
        s += "Z"
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return d.astimezone(timezone.utc)


def _num(v: Any) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def parse_kp_feed(data: Any) -> KpReading | None:
    """Accepts both formats SWPC has used: an array of arrays with a header row, or an array of objects."""
    if not isinstance(data, list) or not data:
        return None
    if isinstance(data[0], list):
        header = [str(h).lower() for h in data[0]]
        if "time_tag" not in header:
            return None
        ki = next((i for i, h in enumerate(header) if h in ("kp", "kp_index")), -1)
        if ki < 0:
            return None
        ti = header.index("time_tag")
        rows = [(r[ti] if len(r) > ti else None, r[ki] if len(r) > ki else None) for r in data[1:] if isinstance(r, list)]
    else:
        rows = []
        for o in data:
            if isinstance(o, dict):
                kp = next((o[k] for k in ("Kp", "kp", "kp_index") if o.get(k) is not None), None)
                rows.append((o.get("time_tag"), kp))
    for t, k in reversed(rows):
        kp, time = _num(k), _parse_time(t)
        if kp is not None and time:
            return KpReading(kp=kp, time=time, label=describe_kp(kp))
    return None
