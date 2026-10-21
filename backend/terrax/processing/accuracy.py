"""Map accuracy and area estimation from a stratified random sample (Olofsson et al. 2014).

A classified map is checked against reference labels at sample points drawn at
random within each map class (stratum). With W_i the mapped area share of class
i, n_ij the sample count of map class i with reference class j and n_i· the
sample size in stratum i, the estimated area proportions are

    p̂_ij = W_i n_ij / n_i·                                   (Olofsson et al. 2014, eq. 4)

from which overall, user's and producer's accuracy and the area of each
reference class follow, with standard errors from eqs. 5–7 and 10. The area
estimates correct the map's own pixel counts for its errors; their confidence
intervals are what should be reported.

Reference: Olofsson P, Foody GM, Herold M, Stehman SV, Woodcock CE, Wulder MA
(2014) Good practices for estimating area and assessing accuracy of land
change. Remote Sensing of Environment 148: 42–57.
"""

from __future__ import annotations

import math

import numpy as np

Z95 = 1.959964  # two-sided 95 % normal quantile


def allocate(areas: np.ndarray, n_total: int, n_min: int = 50) -> np.ndarray:
    """Sample size per stratum: at least `n_min` (or the whole class if smaller), the rest proportional to area.

    Olofsson et al. (2014, section 5.1.2) recommend moving from proportional allocation towards equal sizes
    so that rare classes get enough points for their user's accuracy.
    """
    areas = np.asarray(areas, dtype=np.float64)
    k = areas.size
    present = areas > 0
    base = np.where(present, n_min, 0).astype(np.int64)
    rest = max(0, n_total - int(base.sum()))
    share = areas / areas.sum() if areas.sum() > 0 else np.zeros(k)
    extra = np.floor(share * rest).astype(np.int64)
    # Largest remainders take the leftover points, so the sizes add up to n_total.
    left = rest - int(extra.sum())
    if left > 0:
        order = np.argsort(-(share * rest - extra), kind="stable")
        extra[order[:left]] += 1
    return base + extra


def stratified_sample(classes: np.ndarray, ids: list[int], sizes: np.ndarray, seed: int = 11, block_rows: int = 512) -> list[tuple[int, int, int]]:
    """(row, col, class) of `sizes[i]` cells drawn at random without replacement from each class `ids[i]`.

    Ranks are drawn first and the map is scanned in row blocks, so no index array of a whole class is built.
    """
    rng = np.random.default_rng(seed)
    h, w = classes.shape
    counts = np.zeros(len(ids), dtype=np.int64)
    for r0 in range(0, h, block_rows):
        block = classes[r0 : r0 + block_rows]
        for i, c in enumerate(ids):
            counts[i] += int(np.count_nonzero(block == c))
    wanted = [np.sort(rng.choice(int(counts[i]), size=min(int(sizes[i]), int(counts[i])), replace=False)) for i in range(len(ids))]
    seen = np.zeros(len(ids), dtype=np.int64)
    out: list[tuple[int, int, int]] = []
    for r0 in range(0, h, block_rows):
        block = classes[r0 : r0 + block_rows]
        for i, c in enumerate(ids):
            flat = np.flatnonzero(block == c)
            if not flat.size:
                continue
            ranks = wanted[i]
            sel = ranks[(ranks >= seen[i]) & (ranks < seen[i] + flat.size)] - seen[i]
            for k in flat[sel]:
                out.append((r0 + int(k) // w, int(k) % w, c))
            seen[i] += flat.size
    return out


def assess(counts: np.ndarray, mapped_area: np.ndarray, labels: list[str]) -> dict:
    """Accuracy and area estimates from the sample error matrix.

    counts[i, j]: sample points of map class i with reference class j (same class order on both axes);
    mapped_area[i]: area of map class i (any unit; estimates are returned in the same unit).
    """
    n = np.asarray(counts, dtype=np.float64)
    a_map = np.asarray(mapped_area, dtype=np.float64)
    k = n.shape[0]
    if n.shape != (k, k) or a_map.shape != (k,):
        raise ValueError("The error matrix must be square with one mapped area per class.")
    total = float(a_map.sum())
    if total <= 0:
        raise ValueError("The map has no area.")
    w = a_map / total
    n_i = n.sum(axis=1)
    use = n_i > 0
    # Strata without sample points contribute nothing that can be estimated; flag them.
    with np.errstate(invalid="ignore", divide="ignore"):
        frac = np.where(use[:, None], n / np.where(use, n_i, 1)[:, None], 0.0)  # n_ij / n_i·
    p = w[:, None] * frac  # eq. 4
    p_ref = p.sum(axis=0)  # p̂_·j, estimated area share of reference class j (eq. 9)
    p_map = p.sum(axis=1)  # = W_i where sampled
    diag = np.diag(p)
    oa = float(diag.sum())
    denom = np.where(n_i > 1, n_i - 1, np.nan)
    ua = np.where(p_map > 0, diag / np.where(p_map > 0, p_map, 1), np.nan)
    pa = np.where(p_ref > 0, diag / np.where(p_ref > 0, p_ref, 1), np.nan)
    v_ua = ua * (1 - ua) / denom  # eq. 6
    v_oa = float(np.nansum(w**2 * ua * (1 - ua) / denom))  # eq. 5
    v_ref = np.nansum((w**2)[:, None] * frac * (1 - frac) / denom[:, None], axis=0)  # eq. 10 (squared)
    # Producer's accuracy (eq. 7), with N_i· the mapped area and N̂_·j = Σ_i N_i· n_ij / n_i· the estimated reference area.
    n_ref = (a_map[:, None] * frac).sum(axis=0)
    v_pa = np.full(k, np.nan)
    for j in range(k):
        if n_ref[j] <= 0 or not np.isfinite(pa[j]):
            continue
        own = a_map[j] ** 2 * (1 - pa[j]) ** 2 * ua[j] * (1 - ua[j]) / denom[j] if np.isfinite(ua[j]) else 0.0
        others = sum(a_map[i] ** 2 * frac[i, j] * (1 - frac[i, j]) / denom[i] for i in range(k) if i != j and np.isfinite(denom[i]))
        v_pa[j] = (own + pa[j] ** 2 * others) / n_ref[j] ** 2

    def ci(v: float) -> float | None:
        return None if not np.isfinite(v) else Z95 * math.sqrt(max(0.0, v))

    classes = []
    for j in range(k):
        share_ci = ci(v_ref[j])
        classes.append({
            "label": labels[j], "samples": int(n_i[j]), "mappedArea": float(a_map[j]), "mappedShare": float(w[j]),
            "userAccuracy": None if not np.isfinite(ua[j]) else float(ua[j]), "userCi": ci(v_ua[j]),
            "producerAccuracy": None if not np.isfinite(pa[j]) else float(pa[j]), "producerCi": ci(v_pa[j]),
            "areaShare": float(p_ref[j]), "area": float(p_ref[j] * total), "areaCi": None if share_ci is None else share_ci * total,
        })
    return {
        "labels": labels, "counts": n.astype(int).tolist(), "proportions": p.tolist(), "samples": int(n.sum()), "totalArea": total,
        "overallAccuracy": oa, "overallCi": ci(v_oa), "classes": classes, "unsampled": [labels[i] for i in range(k) if not use[i] and a_map[i] > 0],
    }
