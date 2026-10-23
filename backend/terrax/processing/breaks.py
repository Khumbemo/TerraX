"""Per-pixel disturbance dating in a multi-date image series: one abrupt drop (a level shift) on a linear trend.

For each pixel with dates tᵢ and values yᵢ (NDVI or another index; cloud-masked dates are missing), two models are
fitted by least squares on its valid dates:

    M0:  y = a + b·t                         (no break)
    M1:  y = a + b·t + c·[t ≥ t_k]           (a level shift c between the dates t_(k−1) and t_k)

M1 is the single-break "trend + break" model of BFAST (Verbesselt et al. 2010) with a common slope, as suits short,
sparse series. Every k that leaves at least two valid dates on each side is tried and the best (least residual sum of
squares) kept. The break date is itself estimated, so it counts as a parameter: the model with the lower Bayesian
information criterion wins,

    BIC0 = n·ln(RSS0/n) + 2·ln n,    BIC1 = n·ln(RSS1/n) + 4·ln n,

and a pixel is marked disturbed when M1 wins and the shift is a drop of at least `min_drop` (c ≤ −min_drop). The
disturbance happened after the last date before t_k and by t_k; the map gives that interval, not a day.

References: Verbesselt J, Hyndman R, Newnham G, Culvenor D (2010) Detecting trend and seasonal changes in satellite
image time series. Remote Sensing of Environment 114: 106–115. Schwarz G (1978) Estimating the dimension of a model.
Annals of Statistics 6: 461–464.
"""

from __future__ import annotations

import numpy as np

#: The fewest valid dates a pixel needs: three parameters plus two degrees of freedom.
MIN_DATES = 5


def fit_breaks(t: np.ndarray, y: np.ndarray, min_drop: float) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """For values y (dates × pixels, NaN = missing) at times t (dates), per pixel: the index of the first valid date
    after the drop and of the last valid date before it (−1 for no disturbance), the shift c (NaN for none) and the
    number of valid dates. Break positions between the same two valid dates fit identically (a cloudy date between
    them adds nothing), so the disturbance is dated by that pair of observed dates."""
    t = np.asarray(t, dtype=np.float64)
    t = t - t.mean()  # centred, for well-conditioned normal equations
    n_dates, n_pix = y.shape
    w = np.isfinite(y)
    yv = np.where(w, y, 0.0).astype(np.float64)
    wf = w.astype(np.float64)
    nv = wf.sum(axis=0)
    st, stt = wf.T @ t, wf.T @ (t * t)
    sy, sty, syy = yv.sum(axis=0), yv.T @ t, (yv * yv).sum(axis=0)

    # M0: two parameters, closed form.
    det0 = nv * stt - st * st
    ok0 = (nv >= MIN_DATES) & (det0 > 1e-12)
    safe0 = np.where(ok0, det0, 1.0)
    a0 = (stt * sy - st * sty) / safe0
    b0 = (nv * sty - st * sy) / safe0
    rss0 = np.maximum(syy - a0 * sy - b0 * sty, 0.0)

    best_rss = np.full(n_pix, np.inf)
    best_k = np.full(n_pix, -1, dtype=np.int64)
    best_c = np.full(n_pix, np.nan)
    after_n = np.cumsum(wf[::-1], axis=0)[::-1]  # valid dates at index ≥ k, for each k
    for k in range(1, n_dates):
        s = (np.arange(n_dates) >= k).astype(np.float64)
        ns = after_n[k]
        feasible = ok0 & (ns >= 2) & (nv - ns >= 2)
        if not feasible.any():
            continue
        sts = wf.T @ (t * s)
        sys = yv.T @ s
        # Normal equations [[n, St, Ns], [St, Stt, Sts], [Ns, Sts, Ns]] β = [Sy, Sty, Sys], solved by Cramer's rule on
        # whole arrays (a symmetric 3 × 3 system per pixel).
        a11, a12, a13, a22, a23, a33 = nv, st, ns, stt, sts, ns
        c11 = a22 * a33 - a23 * a23
        c12 = a13 * a23 - a12 * a33
        c13 = a12 * a23 - a13 * a22
        det = a11 * c11 + a12 * c12 + a13 * c13
        good = feasible & (np.abs(det) > 1e-10)
        if not good.any():
            continue
        d = np.where(good, det, 1.0)
        c22 = a11 * a33 - a13 * a13
        c23 = a12 * a13 - a11 * a23
        c33 = a11 * a22 - a12 * a12
        b1 = (c11 * sy + c12 * sty + c13 * sys) / d
        b2 = (c12 * sy + c22 * sty + c23 * sys) / d
        b3 = (c13 * sy + c23 * sty + c33 * sys) / d
        rss = np.maximum(syy - (b1 * sy + b2 * sty + b3 * sys), 0.0)
        better = good & (rss < best_rss)
        best_rss = np.where(better, rss, best_rss)
        best_k = np.where(better, k, best_k)
        best_c = np.where(better, b3, best_c)

    n = np.maximum(nv, 1.0)
    floor = 1e-10 * n  # a perfect fit would give ln 0
    bic0 = n * np.log(np.maximum(rss0, floor) / n) + 2 * np.log(n)
    bic1 = n * np.log(np.maximum(np.where(np.isfinite(best_rss), best_rss, np.inf), floor) / n) + 4 * np.log(n)
    disturbed = ok0 & (best_k >= 0) & (bic1 < bic0) & (best_c <= -min_drop)
    # The observed dates around the break: first valid at index ≥ k, last valid at index < k.
    idx = np.arange(n_dates)[:, None]
    kb = np.where(disturbed, best_k, n_dates)[None, :]
    after = np.where(w & (idx >= kb), idx, n_dates).min(axis=0)
    before = np.where(w & (idx < kb), idx, -1).max(axis=0)
    return (np.where(disturbed, after, -1), np.where(disturbed, before, -1), np.where(disturbed, best_c, np.nan), nv.astype(np.int64))
