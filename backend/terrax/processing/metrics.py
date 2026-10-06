"""Recognises common Earth-observation variables from a column name and assigns
value classes with a stated basis. Where no standard applies, values are split
into data-driven quartiles instead of invented thresholds."""

from __future__ import annotations

import math
import re
from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np

from .stats import quantile_sorted

INF = math.inf
VEG = ["#8c6d4f", "#b59b6b", "#d8cf7a", "#9cc45f", "#4f9d4a", "#1f6f3a"]
HEAT = ["#5a8fd8", "#62b5d6", "#7dc9a0", "#e3c65b", "#e88a3c", "#d0433a"]
WET = ["#6b7280", "#bcd7ef", "#86b8e3", "#4f8fd0", "#2f6cb5", "#1f4b8f", "#172f63"]


def _temp():
    return [(0, "Freezing (< 0 °C)", HEAT[0]), (10, "Cold (0–10 °C)", HEAT[1]), (20, "Cool (10–20 °C)", HEAT[2]),
            (30, "Warm (20–30 °C)", HEAT[3]), (40, "Hot (30–40 °C)", HEAT[4]), (INF, "Very hot (≥ 40 °C)", HEAT[5])]


PROFILES = {
    "ndvi": ("NDVI", "", "Indicative NDVI ranges (USGS). Thresholds vary with sensor, season and biome.",
             [(0, "Water / non-vegetated (< 0)", "#5b7fa6"), (0.1, "Barren (0–0.1)", VEG[0]), (0.2, "Very sparse (0.1–0.2)", VEG[1]),
              (0.4, "Sparse to moderate (0.2–0.4)", VEG[2]), (0.6, "Moderate to dense (0.4–0.6)", VEG[3]), (INF, "Dense (≥ 0.6)", VEG[5])]),
    "evi": ("EVI", "", "Indicative EVI ranges. EVI saturates less than NDVI, so the same canopy scores lower.",
            [(0.1, "Very low (< 0.1)", VEG[0]), (0.2, "Low (0.1–0.2)", VEG[2]), (0.4, "Moderate (0.2–0.4)", VEG[3]), (INF, "High (≥ 0.4)", VEG[5])]),
    "lst": ("Land surface temperature", "°C", "Descriptive temperature bands in °C (0 °C = freezing).", _temp()),
    "airTemp": ("Air temperature", "°C", "Descriptive temperature bands in °C (0 °C = freezing).", _temp()),
    "precip": ("Precipitation", "mm", "India Meteorological Department 24-hour rainfall categories.",
               [(0.1, "No rain (< 0.1 mm)", WET[0]), (2.5, "Very light (0.1–2.4 mm)", WET[1]), (15.6, "Light (2.5–15.5 mm)", WET[2]),
                (64.5, "Moderate (15.6–64.4 mm)", WET[3]), (115.6, "Heavy (64.5–115.5 mm)", WET[4]), (204.5, "Very heavy (115.6–204.4 mm)", WET[5]),
                (INF, "Extremely heavy (≥ 204.5 mm)", WET[6])]),
    "et": ("Evapotranspiration", "mm/day", "Indicative daily ET ranges, in line with FAO-56 reference ET magnitudes.",
           [(1, "Very low (< 1 mm/day)", WET[1]), (3, "Low (1–3 mm/day)", WET[2]), (5, "Moderate (3–5 mm/day)", WET[3]),
            (7, "High (5–7 mm/day)", WET[4]), (INF, "Very high (≥ 7 mm/day)", WET[6])]),
    "solar": ("Solar radiation", "MJ m⁻² day⁻¹", "Indicative daily global radiation ranges. Clear-sky maxima depend on latitude and season.",
              [(8, "Low (< 8)", HEAT[0]), (16, "Moderate (8–16)", HEAT[2]), (24, "High (16–24)", HEAT[3]), (INF, "Very high (≥ 24)", HEAT[5])]),
    "soilMoisture": ("Soil moisture", "m³/m³", "Indicative volumetric soil-moisture ranges; field capacity and wilting point depend on soil texture.",
                     [(0.1, "Very dry (< 0.10 m³/m³)", HEAT[5]), (0.2, "Dry (0.10–0.20)", HEAT[4]), (0.3, "Moderate (0.20–0.30)", HEAT[3]),
                      (0.4, "Moist (0.30–0.40)", WET[2]), (INF, "Wet / near saturation (≥ 0.40)", WET[4])]),
    "humidity": ("Relative humidity", "%", "Descriptive relative-humidity bands.",
                 [(30, "Dry (< 30 %)", HEAT[4]), (60, "Moderate (30–60 %)", HEAT[3]), (80, "Humid (60–80 %)", WET[2]), (INF, "Very humid (≥ 80 %)", WET[4])]),
}
QUARTILE_COLORS = ["#3b5b7a", "#4f86a8", "#6fb3c8", "#a6dcd6"]


def tokenize(name: str) -> list[str]:
    s = re.sub(r"([a-z])([A-Z])", r"\1 \2", name).lower()
    return [t for t in re.split(r"[^a-z0-9]+", s) if t]


def detect_metric(column: str) -> str:
    tokens = tokenize(column)
    has = lambda *w: any(t in w for t in tokens)
    starts = lambda *p: any(t.startswith(x) for t in tokens for x in p)
    if has("ndvi"):
        return "ndvi"
    if has("evi", "evi2"):
        return "evi"
    if has("lst") or (starts("land") and starts("surface") and starts("temp")):
        return "lst"
    if starts("precip", "rain", "prcp") or has("pr", "ppt"):
        return "precip"
    if starts("evapo") or has("et", "aet", "pet", "eto", "et0"):
        return "et"
    if starts("solar", "irradian", "radiation") or has("srad", "ssrd", "ghi", "rs"):
        return "solar"
    if has("soil", "sm", "swc", "vwc", "moisture") or starts("soilmoist"):
        return "soilMoisture"
    if starts("humid") or has("rh"):
        return "humidity"
    if starts("temp") or has("t2m", "tmean", "tmax", "tmin", "tavg"):
        return "airTemp"
    return "generic"


def is_known_metric(column: str) -> bool:
    return detect_metric(column) != "generic"


@dataclass
class Classification:
    metric: str
    name: str
    unit: str
    basis: str
    note: str | None
    buckets: list[dict]
    convert: Callable[[float], float] = field(repr=False)
    _bounds: list[float] = field(default_factory=list, repr=False)

    def classify(self, raw: float) -> int:
        if raw is None or not math.isfinite(raw):
            return -1
        v = self.convert(raw)
        for i, up in enumerate(self._bounds):
            if v < up:
                return i
        return len(self._bounds) - 1

    def public(self) -> dict:
        return {"metric": self.metric, "name": self.name, "unit": self.unit, "basis": self.basis, "note": self.note, "buckets": self.buckets}


def _from_profile(pid: str, convert, note, unit=None) -> Classification:
    name, u, basis, classes = PROFILES[pid]
    return Classification(pid, name, u if unit is None else unit, basis, note, [{"label": l, "color": c} for _, l, c in classes], convert, [up for up, _, _ in classes])


def build_classification(column: str, values, spacing: tuple[float, float] | None) -> Classification:
    """Classes for one column; `spacing` is (median, min) days between records, if any."""
    interval = spacing[0] if spacing else None
    metric = detect_metric(column)
    s = np.sort(np.asarray([v for v in values if v is not None and math.isfinite(v)], dtype=float))
    median = quantile_sorted(s, 0.5) if s.size else math.nan
    ident = lambda v: v
    if metric in ("ndvi", "evi"):
        if 1.5 < median <= 10000:
            return _from_profile(metric, lambda v: v / 10000, "Values look scaled by 10,000 (as in MODIS MOD13) and were divided by 10,000 before classifying.")
        return _from_profile(metric, ident, None)
    if metric in ("lst", "airTemp"):
        if median > 150:
            return _from_profile(metric, lambda v: v - 273.15, "Values look like Kelvin and were converted to °C (K − 273.15) before classifying.")
        return _from_profile(metric, ident, None)
    if metric == "precip":
        if not (spacing and (spacing[1] < 0.75 or spacing[1] > 1.25)):
            note = None
            if not spacing:
                note = "No time column found; values were assumed to be 24-hour totals."
            elif spacing[0] > 1.25:
                note = "Records are daily totals with gaps between some days; each value was classified as a 24-hour total."
            return _from_profile("precip", ident, note)
    elif metric == "et":
        if interval is not None and interval > 1.5:
            days = interval
            return _from_profile("et", lambda v: v / days,
                                 f"Records are {round(days)} days apart. Values were treated as totals per interval (as in MODIS MOD16A2 8-day ET) and divided by {round(days * 10) / 10:g} to get mm/day.")
        return _from_profile("et", ident, None)
    elif metric in ("solar", "humidity"):
        return _from_profile(metric, ident, None)
    elif metric == "soilMoisture":
        if median > 1:
            return _from_profile("soilMoisture", lambda v: v / 100, "Values look like percent and were divided by 100 to get m³/m³.")
        return _from_profile("soilMoisture", ident, None)

    q1, q2, q3 = quantile_sorted(s, 0.25), median, quantile_sorted(s, 0.75)
    f = lambda v: f"{float(f'{v:.3g}'):g}" if math.isfinite(v) else "—"
    reason = None
    if metric == "precip":
        reason = (f"The closest records are {round(spacing[1] * 10) / 10:g} days apart, but rainfall categories are defined for 24-hour totals, so quartiles are shown instead."
                  if spacing else None)
    return Classification(
        metric, PROFILES["precip"][0] if metric == "precip" else column, "", "Quartiles of this dataset (no standard classes apply).", reason,
        [{"label": f"Lowest 25 % (< {f(q1)})", "color": QUARTILE_COLORS[0]}, {"label": f"25–50 % ({f(q1)}–{f(q2)})", "color": QUARTILE_COLORS[1]},
         {"label": f"50–75 % ({f(q2)}–{f(q3)})", "color": QUARTILE_COLORS[2]}, {"label": f"Highest 25 % (≥ {f(q3)})", "color": QUARTILE_COLORS[3]}],
        ident, [q1, q2, q3, INF],
    )
