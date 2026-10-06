"""Per-column analysis of a table: summary, trend, seasonal cycle and climate statistics."""

from __future__ import annotations

import math
from dataclasses import dataclass

from .climate import compute_spi, monthly_anomalies, seasonal_kendall, to_monthly
from .dates import MONTHS, decimal_year, format_date
from .metrics import Classification, build_classification, detect_metric
from .stats import Summary, Trend, summarize, trend_test
from .table import Table

SPI_SCALES = [1, 3, 6, 12]
SPI_MIN_YEARS = 10


@dataclass
class MetricAnalysis:
    column: str
    points: list[dict]
    summary: Summary | None
    trend: Trend | None
    monthly: list[dict] | None
    classification: Classification
    class_counts: list[int]
    trend_caveat: str | None
    start: object
    end: object
    climate: dict | None

    def public(self, max_points: int = 1500) -> dict:
        from .stats import quantile_sorted, sample_indices

        idx = sample_indices(len(self.points), max_points)
        intercept = None
        if self.trend and self.points and self.points[0]["time"]:
            # Theil–Sen intercept: median of y − slope·t over all values, for drawing the trend line.
            intercept = quantile_sorted(sorted(p["value"] - self.trend.sen_slope * decimal_year(p["time"]) for p in self.points), 0.5)
        return {
            "column": self.column,
            "points": [
                {"label": self.points[i]["label"], "time": format_date(self.points[i]["time"]) if self.points[i]["time"] else None, "value": self.points[i]["value"],
                 "t": decimal_year(self.points[i]["time"]) if self.points[i]["time"] else None, "cls": self.classification.classify(self.points[i]["value"])}
                for i in idx
            ],
            "sampled": len(idx) < len(self.points),
            "pointCount": len(self.points),
            "trendIntercept": intercept,
            "summary": self.summary.dict() if self.summary else None,
            "trend": self.trend.dict() if self.trend else None,
            "monthly": self.monthly,
            "classification": self.classification.public(),
            "classCounts": self.class_counts,
            "trendCaveat": self.trend_caveat,
            "start": format_date(self.start) if self.start else None,
            "end": format_date(self.end) if self.end else None,
            "climate": _climate_public(self.climate) if self.climate else None,
        }


def _climate_public(c: dict) -> dict:
    return {
        "monthly": [vars(m) for m in c["monthly"]],
        "seasonalKendall": c["seasonalKendall"],
        "anomalies": c["anomalies"],
        "spi": c["spi"],
        "spiNote": c["spiNote"],
    }


def analyze_metric(ds: Table, column: str) -> MetricAnalysis:
    points = []
    for i, row in enumerate(ds.rows):
        v = row.get(column)
        if not isinstance(v, float) or not math.isfinite(v):
            continue
        t = ds.times[i] if ds.times else None
        if ds.times and not t:
            continue
        points.append({"row": i, "time": t, "label": format_date(t) if t else f"Row {i + 1}", "value": v})
    if ds.times:
        points.sort(key=lambda p: p["time"])
    values = [p["value"] for p in points]
    summary = summarize(values)
    spacing = None if ds.interval_days is None else (ds.interval_days, ds.min_interval_days if ds.min_interval_days is not None else ds.interval_days)
    cls = build_classification(column, values, spacing)
    counts = [0] * len(cls.buckets)
    for v in values:
        k = cls.classify(v)
        if k >= 0:
            counts[k] += 1

    trend = monthly = caveat = None
    start = points[0]["time"] if points else None
    end = points[-1]["time"] if points else None
    span = (end - start).days / 365.25 if start and end else 0.0
    if ds.times and len(points) >= 4:
        trend = trend_test([decimal_year(p["time"]) for p in points], values)
        if span < 1.9:
            if span < 1:
                months = max(1, round(span * 12))
                caveat = f"The record covers {months} month{'' if round(span * 12) == 1 else 's'}, less than two seasonal cycles, so this trend mostly reflects the seasonal cycle, not a long-term change."
            else:
                caveat = f"The record covers {span:.1f} years, less than two seasonal cycles, so this trend mostly reflects the seasonal cycle, not a long-term change."
        if span >= 1.9 and (ds.interval_days if ds.interval_days is not None else 999) <= 31:
            sums, ns = [0.0] * 12, [0] * 12
            for p in points:
                m = p["time"].month - 1
                sums[m] += p["value"]
                ns[m] += 1
            monthly = [{"month": m, "label": MONTHS[m], "mean": sums[m] / ns[m], "n": ns[m]} for m in range(12) if ns[m]]

    climate = None
    if ds.times and span >= 1.9 and (ds.interval_days if ds.interval_days is not None else 999) <= 31:
        mv = to_monthly([(p["time"], p["value"]) for p in points], ds.interval_days)
        usable = [m for m in mv if m.coverage >= 0.8]
        spi = note = None
        if detect_metric(column) == "precip":
            years = len({m.year for m in usable})
            if years >= SPI_MIN_YEARS:
                spi = [compute_spi(mv, k, (ds.interval_days or 30) <= 1.5) for k in SPI_SCALES]
            else:
                note = f"The Standardized Precipitation Index needs at least {SPI_MIN_YEARS} years of monthly data (30 or more recommended); this record has {years}."
        climate = {"monthly": usable, "seasonalKendall": seasonal_kendall(usable), "anomalies": monthly_anomalies(usable)["rows"], "spi": spi, "spiNote": note}
    return MetricAnalysis(column, points, summary, trend, monthly, cls, counts, caveat, start, end, climate)
