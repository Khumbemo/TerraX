"""Descriptive statistics and trend tests shared by the tools."""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from typing import Sequence

import numpy as np
from scipy.stats import norm


def quantile_sorted(sorted_values: Sequence[float] | np.ndarray, p: float) -> float:
    """Linear-interpolated quantile of an ascending array (Hyndman–Fan type 7, R's default)."""
    a = np.asarray(sorted_values, dtype=float)
    if a.size == 0:
        return math.nan
    h = (a.size - 1) * p
    lo, hi = math.floor(h), math.ceil(h)
    return float(a[lo] + (h - lo) * (a[hi] - a[lo]))


@dataclass
class Summary:
    n: int
    mean: float
    sd: float
    min: float
    max: float
    median: float
    q1: float
    q3: float

    def dict(self) -> dict:
        return asdict(self)


def summarize(values: Sequence[float] | np.ndarray) -> Summary | None:
    """n, mean, sample SD, range and quartiles of finite values; None when empty."""
    a = np.asarray(values, dtype=float)
    a = a[np.isfinite(a)]
    if a.size == 0:
        return None
    s = np.sort(a)
    return Summary(
        n=int(a.size),
        mean=float(a.mean()),
        sd=float(a.std(ddof=1)) if a.size > 1 else 0.0,
        min=float(s[0]),
        max=float(s[-1]),
        median=quantile_sorted(s, 0.5),
        q1=quantile_sorted(s, 0.25),
        q3=quantile_sorted(s, 0.75),
    )


def histogram(values: np.ndarray, vmin: float, vmax: float, bins: int = 30) -> list[dict]:
    a = np.asarray(values, dtype=float)
    a = a[np.isfinite(a)]
    if a.size == 0 or not (math.isfinite(vmin) and math.isfinite(vmax)):
        return []
    if vmin == vmax:
        return [{"x0": vmin, "x1": vmax, "count": int(a.size)}]
    width = (vmax - vmin) / bins
    idx = np.minimum(bins - 1, np.floor((a - vmin) / width).astype(int))
    counts = np.bincount(idx, minlength=bins)
    return [{"x0": vmin + i * width, "x1": vmin + (i + 1) * width, "count": int(counts[i])} for i in range(bins)]


def normal_cdf(z: float) -> float:
    return float(norm.cdf(z))


@dataclass
class Trend:
    n: int
    ols_slope: float
    sen_slope: float
    s: float
    z: float
    p: float
    direction: str

    def dict(self) -> dict:
        return asdict(self)


def trend_test(x: Sequence[float], y: Sequence[float], alpha: float = 0.05) -> Trend | None:
    """Mann–Kendall test (tie- and continuity-corrected) with Theil–Sen and OLS slopes.

    ``x`` should be in decimal years so slopes are per year. Assumes serially
    independent observations.
    """
    xa = np.asarray(x, dtype=float)
    ya = np.asarray(y, dtype=float)
    n = min(xa.size, ya.size)
    if n < 4:
        return None
    xa, ya = xa[:n], ya[:n]
    mx, my = xa.mean(), ya.mean()
    sxx = float(((xa - mx) ** 2).sum())
    ols = float(((xa - mx) * (ya - my)).sum() / sxx) if sxx > 0 else 0.0
    order = np.argsort(xa, kind="stable")
    xs, ys = xa[order], ya[order]
    i, j = np.triu_indices(n, k=1)
    d = ys[j] - ys[i]
    s = float(np.sign(d).sum())
    dx = xs[j] - xs[i]
    ok = dx != 0
    slopes = np.sort(d[ok] / dx[ok])
    sen = quantile_sorted(slopes, 0.5) if slopes.size else 0.0
    _, counts = np.unique(ys, return_counts=True)
    t = counts[counts > 1].astype(float)
    var_s = (n * (n - 1) * (2 * n + 5) - float((t * (t - 1) * (2 * t + 5)).sum())) / 18
    if var_s > 0:
        z = (s - 1) / math.sqrt(var_s) if s > 0 else (s + 1) / math.sqrt(var_s) if s < 0 else 0.0
    else:
        z = 0.0
    p = 2 * (1 - normal_cdf(abs(z)))
    direction = ("increasing" if s > 0 else "decreasing") if p < alpha else "no trend"
    return Trend(n=n, ols_slope=ols, sen_slope=sen, s=s, z=z, p=p, direction=direction)


def sample_indices(length: int, max_points: int) -> list[int]:
    if length <= max_points:
        return list(range(length))
    step = (length - 1) / (max_points - 1)
    return [round(i * step) for i in range(max_points)]


def fmt(v: float | None, sig: int = 4) -> str:
    """A number to `sig` significant figures for reports (thousands with separators)."""
    if v is None or not isinstance(v, (int, float, np.floating, np.integer)) or not math.isfinite(float(v)):
        return "—"
    v = float(v)
    a = abs(v)
    if a != 0 and (a >= 1e7 or a < 1e-4):
        return f"{v:.2e}".replace("e+0", "e+").replace("e-0", "e-")
    if a >= 1000:
        r = round(v, 1)
        return f"{r:,.1f}".rstrip("0").rstrip(".")
    out = float(f"{v:.{sig}g}")
    return str(int(out)) if out.is_integer() else repr(out)


def fmt_p(p: float) -> str:
    if p is None or not math.isfinite(p):
        return "—"
    return "< 0.001" if p < 0.001 else f"{p:.3f}"


def thousands(n: int | float) -> str:
    return f"{int(n):,}"
