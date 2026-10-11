"""Unsupervised land-cover classification with scikit-learn's k-means.

Lloyd's algorithm with k-means++ seeding (Arthur & Vassilvitskii 2007) on
standardised bands. Clusters are spectral groups; they become land-cover classes
only when the user names them, and their accuracy is unknown until checked
against reference data (Olofsson et al. 2014).
"""

from __future__ import annotations

import numpy as np
from sklearn.cluster import KMeans

from .rio import QA_KINDS, Raster, qa_masked
from .stats import fmt
from .tiles import Strip, StripPlan
from .zonal import clip_note

PALETTE = ["#1b9e77", "#d95f02", "#7570b3", "#e7298a", "#66a61e", "#e6ab02", "#a6761d", "#1f78b4", "#b2df8a", "#fb9a99"]


def _suggest(ndvi: float | None) -> str | None:
    if ndvi is None:
        return None
    if ndvi < 0:
        return "Water"
    if ndvi < 0.2:
        return "Bare soil or built-up"
    if ndvi < 0.5:
        return "Sparse vegetation or cropland"
    return "Dense vegetation"


def _combine_moments(parts: list[tuple[int, np.ndarray, np.ndarray, int, int]], d: int) -> tuple[np.ndarray, np.ndarray]:
    """Mean and population SD per band from per-strip (count, mean, sum of squared deviations).

    Chan, Golub & LeVeque (1979) pairwise update: numerically stable, unlike E[x²] − E[x]².
    """
    n, mean, m2 = 0, np.zeros(d), np.zeros(d)
    for c, mu, ss, _, _ in parts:
        if not c:
            continue
        delta = mu - mean
        total = n + c
        mean = mean + delta * (c / total)
        m2 = m2 + ss + delta * delta * (n * c / total)
        n = total
    sd = np.sqrt(m2 / n)
    sd[sd == 0] = 1
    return mean, sd


def classify_land_cover(raster: Raster, bands: list[int], k: int, roles: dict, boundary=None, qa: dict | None = None, seed: int = 7, max_training: int = 20_000) -> dict:
    """k-means over every valid pixel, in strips: statistics, a training sample, then prediction strip by strip."""
    if not bands:
        raise ValueError("Choose at least one band.")
    if not isinstance(k, int) or k < 2 or k > len(PALETTE):
        raise ValueError(f"Choose between 2 and {len(PALETTE)} classes.")
    plan = StripPlan(raster, boundary)
    w, h, d = plan.width, plan.height, len(bands)

    def read(st: Strip) -> tuple[np.ndarray, np.ndarray, int, int]:
        """(pixels × bands for valid cells, valid mask, cells removed by QA, cells inside the boundary)."""
        arrays = raster.read_rows(bands, st.r0, st.r1)
        masked = inside = 0
        if qa:
            m = qa_masked(qa["kind"], raster.read_rows([qa["band"]], st.r0, st.r1)[0])
            masked = int(m.sum())
            for a in arrays:
                a[m] = np.nan
        if st.inside is not None:
            inside = int(st.inside.sum())
            for a in arrays:
                a[~st.inside] = np.nan
        stack = np.stack([a.astype(np.float64) for a in arrays], axis=-1).reshape(-1, d)
        valid = np.all(np.isfinite(stack), axis=1)
        return stack[valid], valid, masked, inside

    # Pass 1: valid cells per strip and per-band mean and spread for the z-scores.
    def moments(st: Strip) -> tuple[int, np.ndarray, np.ndarray, int, int]:
        X, _, masked, inside = read(st)
        if not X.shape[0]:
            return 0, np.zeros(d), np.zeros(d), masked, inside
        mu = X.mean(axis=0)
        return X.shape[0], mu, ((X - mu) ** 2).sum(axis=0), masked, inside

    m1 = plan.map(moments)
    plan.check_overlap(sum(m[4] for m in m1))
    counts = np.array([m[0] for m in m1], dtype=np.int64)
    n = int(counts.sum())
    if n < k:
        raise ValueError("Too few valid pixels to classify.")
    mean, sd = _combine_moments(m1, d)

    # Pass 2: the training sample, drawn exactly as from one array of all valid cells (row-major order).
    # k-means++ seeding depends on the order of the training rows, so they keep the order rng.choice drew them in.
    rng = np.random.default_rng(seed + 101)
    drawn = np.arange(n) if n <= max_training else rng.choice(n, size=max_training, replace=False)
    order_back = np.argsort(drawn, kind="stable")
    picks = drawn[order_back]
    starts = np.concatenate([[0], np.cumsum(counts)])

    def sample(job: tuple[int, Strip]) -> np.ndarray:
        si, st = job
        local = picks[(picks >= starts[si]) & (picks < starts[si + 1])] - starts[si]
        return read(st)[0][local] if local.size else np.empty((0, d))

    jobs = [(si, plan.strip(*b)) for si, b in enumerate(plan.bounds) if counts[si]]
    rows_sorted = np.vstack([sample(j) for j in jobs])
    rows_drawn = np.empty_like(rows_sorted)
    rows_drawn[order_back] = rows_sorted
    train = (rows_drawn - mean) / sd
    km = KMeans(n_clusters=k, init="k-means++", n_init=1, max_iter=100, random_state=seed, algorithm="lloyd").fit(train)

    # Pass 3: classify every strip; class codes are cluster + 1 until they are ranked below.
    ri = bands.index(roles["red"]) if roles.get("red") is not None and roles["red"] in bands else -1
    ni = bands.index(roles["nir"]) if roles.get("nir") is not None and roles["nir"] in bands else -1
    classes = np.zeros((h, w), dtype=np.uint8)

    def predict(st: Strip) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        X, valid, _, _ = read(st)
        raw = km.predict((X - mean) / sd) if X.shape[0] else np.empty(0, dtype=np.int64)
        c = np.zeros(valid.size, dtype=np.uint8)
        c[valid] = raw + 1
        classes[st.rows] = c.reshape(st.r1 - st.r0, w)
        m2 = np.bincount(raw, weights=st.area[np.flatnonzero(valid) // w], minlength=k) if st.area is not None else np.zeros(k)
        sums = np.stack([np.bincount(raw, weights=X[:, a], minlength=k) for a in range(d)], axis=1)
        nd_s, nd_c = np.zeros(k), np.zeros(k)
        if ri >= 0 and ni >= 0:
            r, nr = X[:, ri], X[:, ni]
            ok = (r + nr) != 0
            nd = np.where(ok, (nr - r) / np.where(ok, nr + r, 1), 0)
            nd_s = np.bincount(raw[ok], weights=nd[ok], minlength=k).astype(float)
            nd_c = np.bincount(raw[ok], minlength=k).astype(float)
        return np.bincount(raw, minlength=k).astype(float), m2, sums, nd_s, nd_c

    areas_px, m2, sums, nd_s, nd_c = np.zeros(k), np.zeros(k), np.zeros((k, d)), np.zeros(k), np.zeros(k)
    for px_s, m2_s, sums_s, nds_s, ndc_s in plan.map(predict):
        areas_px += px_s
        m2 += m2_s
        sums += sums_s
        nd_s += nds_s
        nd_c += ndc_s
    ndvi: list[float | None] = [float(nd_s[j] / nd_c[j]) if (ri >= 0 and ni >= 0 and nd_c[j]) else None for j in range(k)]
    # Order clusters by NDVI (or overall brightness) so class numbers are stable and readable.
    known = [v for v in ndvi if v is not None]
    if len(known) == k:
        order = sorted(range(k), key=lambda j: known[j])
    else:
        order = sorted(range(k), key=lambda j: sums[j].sum() / (areas_px[j] or 1))
    lut = np.zeros(k + 1, dtype=np.uint8)
    lut[np.array(order) + 1] = np.arange(1, k + 1)
    for b in plan.row_blocks():
        classes[b] = lut[classes[b]]
    geo = plan.geo
    stats = [{"id": i + 1, "pixels": int(areas_px[j]), "ha": float(m2[j] / 10_000) if geo else None, "share": float(areas_px[j] / n),
              "bandMeans": [float(v) for v in sums[j] / (areas_px[j] or 1)], "ndvi": ndvi[j], "suggestion": _suggest(ndvi[j])} for i, j in enumerate(order)]
    sampled = " sampled at random" if train.shape[0] < n else ""
    notes: list[str] = []
    if boundary:
        notes.append(clip_note(boundary, sum(m[4] for m in m1)))
    if qa:
        frac = sum(m[3] for m in m1) / (w * h) if w * h else 0.0
        notes.append(f"Quality mask from band {qa['band'] + 1} ({QA_KINDS[qa['kind']]['rule']}) removed {frac * 100:.1f} % of pixels.")
    notes += [
        f"k-means (scikit-learn, Lloyd’s algorithm) with k-means++ seeding on {d} standardised band{'' if d == 1 else 's'} ({', '.join(f'band {b + 1}' for b in bands)}); {train.shape[0]:,} training pixels{sampled}; converged in {km.n_iter_} iterations.",
        "Clusters are groups of similar spectra, not land-cover classes: name them from local knowledge or high-resolution imagery. The suggested names come only from each cluster’s mean NDVI.",
        "Before reporting areas, check the map against reference points and estimate accuracy and area with a stratified sample (Olofsson et al. 2014); unsupervised classes often mix cover types.",
    ]
    if geo:
        notes.append(geo.note)
    if raster.resample_factor > 1:
        notes.append(f"Classified on a resampled grid (each cell = {fmt(raster.resample_factor, 3)} original pixels).")
    return {"filename": raster.meta.filename, "bands": bands, "k": k, "width": w, "height": h, "classes": classes, "stats": stats,
            "iterations": int(km.n_iter_), "trainingPixels": int(train.shape[0]), "notes": notes}


def land_cover_markdown(r: dict, labels: list[str]) -> str:
    rows = []
    for i, c in enumerate(r["stats"]):
        label = labels[i] if i < len(labels) and labels[i] else "—"
        area = f"{c['pixels']:,} px" if c["ha"] is None else f"{fmt(c['ha'], 4)} ha"
        nd = "—" if c["ndvi"] is None else fmt(c["ndvi"], 3)
        rows.append(f"| {c['id']} | {label} | {area} | {c['share'] * 100:.1f} % | {nd} | {' · '.join(fmt(v, 4) for v in c['bandMeans'])} |")
    return "\n".join([
        "## Dataset", "", f"- File: {r['filename']}; bands {', '.join(str(b + 1) for b in r['bands'])}; {r['k']} clusters", "",
        "## Results", "", "| Class | Label | Area | Share | Mean NDVI | Band means |", "|---|---|---|---|---|---|", *rows, "",
        "## Method and limits", "", *[f"- {n}" for n in r["notes"]],
    ])
