"""Unsupervised land-cover classification with scikit-learn's k-means.

Lloyd's algorithm with k-means++ seeding (Arthur & Vassilvitskii 2007) on
standardised bands. Clusters are spectral groups; they become land-cover classes
only when the user names them, and their accuracy is unknown until checked
against reference data (Olofsson et al. 2014).
"""

from __future__ import annotations

import numpy as np
from sklearn.cluster import KMeans

from .rio import Raster, apply_qa, ground_geometry
from .stats import fmt
from .zonal import clip_to_boundary

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


def classify_land_cover(raster: Raster, bands: list[int], k: int, roles: dict, boundary=None, qa: dict | None = None, seed: int = 7, max_training: int = 20_000) -> dict:
    if not bands:
        raise ValueError("Choose at least one band.")
    if not isinstance(k, int) or k < 2 or k > len(PALETTE):
        raise ValueError(f"Choose between 2 and {len(PALETTE)} classes.")
    grids = raster.read_bands(bands)
    notes: list[str] = []
    if qa:
        notes.append(apply_qa(raster, grids, qa)[1])
    if boundary:
        note = clip_to_boundary(raster, grids[0], boundary)
        for g in grids[1:]:
            g.data[np.isnan(grids[0].data)] = np.nan
        if note:
            notes.insert(0, note)
    h, w = grids[0].data.shape
    stack = np.stack([g.data.astype(np.float64) for g in grids], axis=-1).reshape(-1, len(bands))
    valid = np.all(np.isfinite(stack), axis=1)
    X = stack[valid]
    if X.shape[0] < k:
        raise ValueError("Too few valid pixels to classify.")
    # Standardise each band (z-scores) so bands with larger ranges do not dominate.
    mean = X.mean(axis=0)
    sd = X.std(axis=0)
    sd[sd == 0] = 1
    Z = (X - mean) / sd
    rng = np.random.default_rng(seed + 101)
    train = Z if Z.shape[0] <= max_training else Z[rng.choice(Z.shape[0], size=max_training, replace=False)]
    km = KMeans(n_clusters=k, init="k-means++", n_init=1, max_iter=100, random_state=seed, algorithm="lloyd").fit(train)
    raw = km.predict(Z)
    geo = ground_geometry(raster.meta, w, h)
    areas_px = np.bincount(raw, minlength=k).astype(float)
    m2 = np.zeros(k)
    if geo:
        rows = np.flatnonzero(valid) // w
        m2 = np.bincount(raw, weights=geo.cell_area[rows], minlength=k)
    sums = np.stack([np.bincount(raw, weights=X[:, a], minlength=k) for a in range(X.shape[1])], axis=1)
    ndvi = [None] * k
    ri = bands.index(roles["red"]) if roles.get("red") is not None and roles["red"] in bands else -1
    ni = bands.index(roles["nir"]) if roles.get("nir") is not None and roles["nir"] in bands else -1
    if ri >= 0 and ni >= 0:
        r, nr = X[:, ri], X[:, ni]
        ok = (r + nr) != 0
        nd = np.where(ok, (nr - r) / np.where(ok, nr + r, 1), 0)
        s = np.bincount(raw[ok], weights=nd[ok], minlength=k)
        c = np.bincount(raw[ok], minlength=k)
        ndvi = [float(s[j] / c[j]) if c[j] else None for j in range(k)]
    # Order clusters by NDVI (or overall brightness) so class numbers are stable and readable.
    if all(v is not None for v in ndvi):
        order = sorted(range(k), key=lambda j: ndvi[j])
    else:
        order = sorted(range(k), key=lambda j: sums[j].sum() / (areas_px[j] or 1))
    rank = np.empty(k, dtype=np.int64)
    rank[order] = np.arange(k)
    classes = np.zeros(h * w, dtype=np.uint8)
    classes[valid] = rank[raw] + 1
    n_valid = int(valid.sum())
    stats = [{"id": i + 1, "pixels": int(areas_px[j]), "ha": float(m2[j] / 10_000) if geo else None, "share": float(areas_px[j] / n_valid),
              "bandMeans": [float(v) for v in sums[j] / (areas_px[j] or 1)], "ndvi": ndvi[j], "suggestion": _suggest(ndvi[j])} for i, j in enumerate(order)]
    d = len(bands)
    sampled = " sampled at random" if train.shape[0] < Z.shape[0] else ""
    notes += [
        f"k-means (scikit-learn, Lloyd’s algorithm) with k-means++ seeding on {d} standardised band{'' if d == 1 else 's'} ({', '.join(f'band {b + 1}' for b in bands)}); {train.shape[0]:,} training pixels{sampled}; converged in {km.n_iter_} iterations.",
        "Clusters are groups of similar spectra, not land-cover classes: name them from local knowledge or high-resolution imagery. The suggested names come only from each cluster’s mean NDVI.",
        "Before reporting areas, check the map against reference points and estimate accuracy and area with a stratified sample (Olofsson et al. 2014); unsupervised classes often mix cover types.",
    ]
    if geo:
        notes.append(geo.note)
    if grids[0].resample_factor > 1:
        notes.append(f"Classified on a resampled grid (each cell = {fmt(grids[0].resample_factor, 3)} original pixels).")
    return {"filename": raster.meta.filename, "bands": bands, "k": k, "width": w, "height": h, "classes": classes.reshape(h, w), "stats": stats,
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
