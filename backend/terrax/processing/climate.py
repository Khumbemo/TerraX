"""Climate statistics on monthly aggregates.

* Seasonal Kendall trend test and seasonal Theil–Sen slope (Hirsch, Slack &
  Smith 1982, Water Resources Research 18:107).
* Monthly anomalies against the record's own monthly climatology.
* Standardized Precipitation Index (McKee, Doesken & Kleist 1993; WMO-No. 1090,
  2012): a gamma fit per calendar month by Thom's (1958) maximum-likelihood
  approximation, with the zero-rain probability.
* Rainfall indices for daily series (IMD rainy day ≥ 2.5 mm, dry spells).
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from datetime import date
from typing import Any

import numpy as np
from scipy.special import gammainc
from scipy.stats import norm

from .dates import MONTHS, days_in_month, format_date
from .stats import fmt, normal_cdf

RAINY_DAY_MM = 2.5


@dataclass
class MonthValue:
    year: int
    month: int  # 0–11
    value: float
    n: int
    coverage: float


def to_monthly(points: list[tuple[date, float]], step_days: float | None) -> list[MonthValue]:
    acc: dict[int, list] = defaultdict(lambda: [0.0, 0, set()])
    for t, v in points:
        e = acc[t.year * 12 + t.month - 1]
        e[0] += v
        e[1] += 1
        e[2].add(t.day)
    daily = step_days is not None and step_days <= 1.5
    out = []
    for key in sorted(acc):
        s, n, days = acc[key]
        y, m = divmod(key, 12)
        out.append(MonthValue(y, m, s / n, n, len(days) / days_in_month(y, m + 1) if daily else 1.0))
    return out


def seasonal_kendall(monthly: list[MonthValue], alpha: float = 0.05) -> dict | None:
    S = V = 0.0
    n = seasons = 0
    slopes: list[float] = []
    for m in range(12):
        xs = sorted((v for v in monthly if v.month == m), key=lambda v: v.year)
        if len(xs) < 2:
            continue
        seasons += 1
        n += len(xs)
        for i in range(len(xs)):
            for j in range(i + 1, len(xs)):
                d = xs[j].value - xs[i].value
                S += (d > 0) - (d < 0)
                slopes.append(d / (xs[j].year - xs[i].year))
        k = len(xs)
        _, counts = np.unique([x.value for x in xs], return_counts=True)
        t = counts[counts > 1].astype(float)
        V += (k * (k - 1) * (2 * k + 5) - float((t * (t - 1) * (2 * t + 5)).sum())) / 18
    if not seasons or V <= 0 or n < 4:
        return None
    z = (S - 1) / math.sqrt(V) if S > 0 else (S + 1) / math.sqrt(V) if S < 0 else 0.0
    p = 2 * (1 - normal_cdf(abs(z)))
    slope = float(np.median(slopes))
    return {"s": S, "varS": V, "z": z, "p": p, "slope": slope, "seasons": seasons, "n": n,
            "direction": ("increasing" if S > 0 else "decreasing") if p < alpha else "no trend"}


def monthly_anomalies(monthly: list[MonthValue]) -> dict:
    clim = []
    means: list[float] = []
    sds: list[float | None] = []
    for m in range(12):
        xs = np.array([v.value for v in monthly if v.month == m], dtype=float)
        means.append(float(xs.mean()) if xs.size else 0.0)
        sds.append(float(xs.std(ddof=1)) if xs.size > 1 else None)
        clim.append({"month": m, "mean": means[m], "sd": sds[m], "years": int(xs.size)})
    rows = []
    for v in monthly:
        a = v.value - means[v.month]
        sd = sds[v.month]
        rows.append({**asdict(v), "anomaly": a, "z": a / sd if sd else None})
    return {"climatology": clim, "rows": rows}


SPI_CLASSES = [(2, "Extremely wet"), (1.5, "Very wet"), (1, "Moderately wet"), (-1, "Near normal"), (-1.5, "Moderately dry"), (-2, "Severely dry"), (-math.inf, "Extremely dry")]


def spi_class(v: float) -> str:
    return next(label for lo, label in SPI_CLASSES if v >= lo)


def compute_spi(monthly: list[MonthValue], scale: int, daily_input: bool) -> dict:
    """SPI at `scale` months from monthly precipitation (mean per observation, as from to_monthly)."""
    if not monthly:
        return {"scale": scale, "rows": [], "years": 0, "reliable": False, "notes": ["No monthly precipitation values."]}
    first = monthly[0].year * 12 + monthly[0].month
    last = monthly[-1].year * 12 + monthly[-1].month
    totals: list[float | None] = [None] * (last - first + 1)
    for v in monthly:
        if v.coverage < 0.8 or v.value < 0:
            continue
        totals[v.year * 12 + v.month - first] = v.value * days_in_month(v.year, v.month + 1) if daily_input else v.value
    acc: list[float | None] = []
    for i in range(len(totals)):
        win = [x for x in totals[i - scale + 1 : i + 1] if x is not None] if i + 1 >= scale else []
        acc.append(float(sum(win)) if len(win) == scale else None)
    rows = [{"year": (first + i) // 12, "month": (first + i) % 12, "total": acc[i], "spi": None} for i in range(len(totals))]
    min_years = math.inf
    for m in range(12):
        idx = [i for i in range(len(rows)) if (first + i) % 12 == m and acc[i] is not None]
        min_years = min(min_years, len(idx))
        xs = np.array([acc[i] for i in idx], dtype=float)
        pos = xs[xs > 0]
        if xs.size < 2 or pos.size < 2:
            continue
        q = (xs.size - pos.size) / xs.size
        mean = pos.mean()
        A = math.log(mean) - float(np.log(pos).mean())
        if not A > 0:
            continue
        alpha = (1 + math.sqrt(1 + 4 * A / 3)) / (4 * A)
        beta = mean / alpha
        for i in idx:
            x = acc[i]
            if x is None:
                continue
            H = q + (1 - q) * (float(gammainc(alpha, x / beta)) if x > 0 else 0.0)
            rows[i]["spi"] = float(norm.ppf(min(1 - 1e-6, max(1e-6, H))))
    years = 0 if math.isinf(min_years) else int(min_years)
    notes = [
        f"SPI-{scale}: {scale}-month precipitation totals fitted with a gamma distribution for each calendar month (Thom 1958 estimator; zero totals handled with their observed probability), then transformed to standard normal values (McKee et al. 1993).",
        "Daily data were summed to monthly totals (mean of observed days × days in the month); months with under 80 % of days observed are treated as missing."
        if daily_input else "Each value was taken as a monthly total.",
        "Classes: ≥ 2 extremely wet, 1.5 to 2 very wet, 1 to 1.5 moderately wet, −1 to 1 near normal, −1.5 to −1 moderately dry, −2 to −1.5 severely dry, ≤ −2 extremely dry.",
    ]
    reliable = years >= 30
    if not reliable:
        notes.append(f"Only {years} years are available for some calendar months; WMO guidance asks for at least 30 years, so these SPI values are indicative only.")
    return {"scale": scale, "rows": rows, "years": years, "reliable": reliable, "notes": notes}


def rainfall_summary(points: Sequence[Mapping[str, Any]], metric: str, min_interval: float | None, start: date | None, end: date | None) -> dict | None:
    """Rainfall indices for daily series (points sorted by time with 'time', 'value', 'label')."""
    if metric != "precip" or min_interval is None or abs(min_interval - 1) > 0.25 or not start or not end or not points:
        return None
    total = 0.0
    rainy = 0
    wettest = points[0]
    run = longest = 0
    prev = None
    for p in points:
        total += p["value"]
        if p["value"] >= RAINY_DAY_MM:
            rainy += 1
        if p["value"] > wettest["value"]:
            wettest = p
        t = p["time"].toordinal()
        consecutive = prev is not None and t - prev == 1
        run = (run + 1 if consecutive else 1) if p["value"] < RAINY_DAY_MM else 0
        longest = max(longest, run)
        prev = t
    span = (end - start).days + 1
    return {"total": total, "days": len(points), "rainyDays": rainy, "wettest": {"value": wettest["value"], "label": wettest["label"]},
            "longestDrySpell": longest, "missingDays": span - len(points)}


def rainfall_markdown(r: dict, start: date | None, end: date | None) -> str:
    return "\n".join([
        "### Rainfall indices", "", "| Index | Value |", "|---|---|",
        f"| Total rainfall (recorded days) | {fmt(r['total'])} mm |",
        f"| Rainy days (≥ {RAINY_DAY_MM} mm, IMD definition) | {r['rainyDays']} of {r['days']} recorded days |",
        f"| Heaviest one-day rainfall | {fmt(r['wettest']['value'])} mm ({r['wettest']['label']}) |",
        f"| Longest dry spell (consecutive days < {RAINY_DAY_MM} mm) | {r['longestDrySpell']} days |", "",
        f"Note: {r['missingDays']} days between {format_date(start)} and {format_date(end)} have no record, so the total and spells describe recorded days only."
        if r["missingDays"] > 0 else f"Complete daily record from {format_date(start)} to {format_date(end)}.",
        "",
    ])


def month_name(m: int) -> str:
    return MONTHS[m]
