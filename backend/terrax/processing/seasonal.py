"""Per-pixel disturbances in a dense image series: a seasonal model, monitored forward, with several breaks and recovery.

In the manner of CCDC (Zhu & Woodcock 2014), each pixel's clear observations (tᵢ in decimal years, yᵢ an index such as
NDVI) are followed through time with a season-trend model

    ŷ(t) = a + b·t + c·cos 2πt + d·sin 2πt                         (trend and an annual cycle)

so images from any month can be compared: the expected value already includes the season.

1. Fit the model on the first `INIT` clear observations of a segment (extended until they span at least a year, so the
   annual cycle is defined), and take its root-mean-square error σ. As in CCDC, the window must be stable: its trend
   over the window (b × span) and its first and last residuals all smaller than the threshold below; if not, it moves
   one observation later. So a disturbance in a pixel's first year of clear data cannot be detected: it has no stable
   year before it.
2. Step through the following observations. One whose residual y − ŷ is a drop of at least max(k·σ, min_drop) is
   anomalous. `consecutive` anomalous observations in a row confirm a disturbance, dated by the first of them; an
   anomalous observation followed by a normal one is treated as noise (cloud edge, haze) and left out of the fit.
   Normal observations are added to the segment and the model refitted.
3. After a disturbance a new segment starts at its first anomalous observation, and steps 1–2 repeat, so a pixel can
   have several disturbances. The new segment's trend measures recovery: the share of the drop regained by the end of
   the series, b_new × (t_end − t_break) / |drop|.

Only drops are mapped (forest loss, fire, clearing); a rise is not a disturbance here. TerraX's choices, stated in the
report: one harmonic (CCDC adds more with more data), a one-sided threshold on one index (CCDC tests several bands
together), and no outlier screening besides the consecutive-observation rule.

References: Zhu Z, Woodcock CE (2014) Continuous change detection and classification of land cover using all available
Landsat data. Remote Sensing of Environment 144: 152–171. Verbesselt J, Zeileis A, Herold M (2012) Near real-time
disturbance detection using satellite image time series. Remote Sensing of Environment 123: 98–108.
"""

from __future__ import annotations

import numpy as np
from numba import njit

INIT = 8  # observations to start a segment: four coefficients and four degrees of freedom
MAX_BREAKS = 8  # recorded per pixel


@njit(cache=True)
def _fit(t: np.ndarray, y: np.ndarray, use: np.ndarray, start: int, stop: int) -> tuple[np.ndarray, float, int]:
    """Least-squares season-trend coefficients over the used observations in [start, stop), their RMSE and count."""
    xtx = np.zeros((4, 4))
    xty = np.zeros(4)
    x = np.empty(4)
    n = 0
    for i in range(start, stop):
        if not use[i]:
            continue
        a = 2.0 * np.pi * t[i]
        x[0], x[1], x[2], x[3] = 1.0, t[i], np.cos(a), np.sin(a)
        for r in range(4):
            xty[r] += x[r] * y[i]
            for c in range(4):
                xtx[r, c] += x[r] * x[c]
        n += 1
    for r in range(4):
        xtx[r, r] += 1e-9  # keeps a degenerate window solvable; far below any real signal
    beta = np.linalg.solve(xtx, xty)
    rss = 0.0
    for i in range(start, stop):
        if use[i]:
            e = y[i] - _predict(beta, t[i])
            rss += e * e
    return beta, np.sqrt(rss / max(n - 4, 1)), n


@njit(cache=True)
def _predict(beta: np.ndarray, t: float) -> float:
    a = 2.0 * np.pi * t
    return beta[0] + beta[1] * t + beta[2] * np.cos(a) + beta[3] * np.sin(a)


@njit(cache=True)
def _init_end(t: np.ndarray, start: int, m: int) -> int:
    """End (exclusive) of a segment's starting window: INIT observations spanning at least a year, or −1."""
    j = start + INIT
    while j <= m and t[j - 1] - t[start] < 1.0:
        j += 1
    return j if j <= m else -1


@njit(cache=True, nogil=True)
def monitor(t: np.ndarray, y: np.ndarray, k: float, consecutive: int, min_drop: float, out_idx: np.ndarray, out_mag: np.ndarray,
            out_n: np.ndarray, out_recovery: np.ndarray, out_valid: np.ndarray) -> None:
    """For values y (dates × pixels, NaN = cloud) at times t (dates, decimal years): per pixel the date indices of up
    to MAX_BREAKS disturbances (out_idx, −1 after the last), their drops (out_mag, negative), their count (out_n), the
    recovery after the last one (out_recovery, NaN when its segment is too short to measure) and whether the pixel had
    enough clear observations to start a model (out_valid)."""
    n_dates, n_pix = y.shape
    tv = np.empty(n_dates)
    yv = np.empty(n_dates)
    di = np.empty(n_dates, dtype=np.int64)
    use = np.empty(n_dates, dtype=np.bool_)
    for p in range(n_pix):
        m = 0
        for d in range(n_dates):
            if np.isfinite(y[d, p]):
                tv[m], yv[m], di[m] = t[d], y[d, p], d
                m += 1
        nb = 0
        out_recovery[p] = np.nan
        out_valid[p] = False
        start = 0
        while True:
            j = _init_end(tv, start, m)
            if j < 0:
                break
            for i in range(start, m):
                use[i] = i < j
            beta, sigma, _ = _fit(tv, yv, use, start, j)
            limit = max(k * sigma, min_drop)
            if (abs(beta[1]) * (tv[j - 1] - tv[start]) >= limit or abs(yv[start] - _predict(beta, tv[start])) >= limit
                    or abs(yv[j - 1] - _predict(beta, tv[j - 1])) >= limit):
                start += 1  # not stable yet: try the window one observation later
                continue
            out_valid[p] = True
            run = 0
            first = -1
            drop = 0.0
            broke = False
            for i in range(j, m):
                r = yv[i] - _predict(beta, tv[i])
                if r <= -max(k * sigma, min_drop):
                    if run == 0:
                        first, drop = i, 0.0
                    run += 1
                    drop += r
                    if run == consecutive:
                        if nb < MAX_BREAKS:
                            out_idx[p, nb] = di[first]
                            out_mag[p, nb] = drop / consecutive
                        nb += 1
                        start = first
                        broke = True
                        out_recovery[p] = np.nan  # measured on the next segment, if it can be fitted
                        break
                else:
                    run = 0
                    use[i] = True  # pending anomalies stay out of the fit
                    beta, sigma, _ = _fit(tv, yv, use, start, i + 1)
            if not broke:
                if nb > 0 and nb <= MAX_BREAKS:  # the segment after the last break ran to the end: its trend is the recovery
                    out_recovery[p] = beta[1] * (tv[m - 1] - tv[start]) / -out_mag[p, nb - 1]
                break
        out_n[p] = nb
        for b in range(min(nb, MAX_BREAKS), MAX_BREAKS):
            out_idx[p, b] = -1
            out_mag[p, b] = np.nan


def fit_seasonal(t: np.ndarray, y: np.ndarray, min_drop: float, k: float = 3.0, consecutive: int = 3) -> dict[str, np.ndarray]:
    """Arrays per pixel from `monitor`, for y of shape (dates, pixels)."""
    n_pix = y.shape[1]
    out = {"index": np.full((n_pix, MAX_BREAKS), -1, dtype=np.int64), "magnitude": np.full((n_pix, MAX_BREAKS), np.nan),
           "count": np.zeros(n_pix, dtype=np.int64), "recovery": np.full(n_pix, np.nan), "valid": np.zeros(n_pix, dtype=np.bool_)}
    # Whole years subtracted: the trend term stays well conditioned and the annual cycle (in t mod 1) is unchanged.
    t = np.asarray(t, dtype=np.float64)
    t = t - np.floor(t.min())
    monitor(np.ascontiguousarray(t), np.ascontiguousarray(y, dtype=np.float64), float(k), int(consecutive), float(min_drop),
            out["index"], out["magnitude"], out["count"], out["recovery"], out["valid"])
    return out
