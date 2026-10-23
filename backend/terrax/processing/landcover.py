"""Unsupervised land-cover classification with scikit-learn's k-means.

Lloyd's algorithm with k-means++ seeding (Arthur & Vassilvitskii 2007) on
standardised bands. Clusters are spectral groups; they become land-cover classes
only when the user names them, and their accuracy is unknown until checked
against reference data (Olofsson et al. 2014).
"""

from __future__ import annotations

from dataclasses import dataclass

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


@dataclass
class RadarInput:
    """Sentinel-1 backscatter on the optical raster's analysis grid, added as random-forest features."""

    raster: Raster
    vv: int
    vh: int
    scale: str  # "db" or "linear"
    name: str = "radar"
    aligned: bool = False  # reprojected onto the optical grid
    source_scale: str = "linear"  # the file's own scale, when it was reprojected

    def rows(self, r0: int, r1: int) -> list[np.ndarray]:
        """VV and VH in dB and their ratio VH/VV in dB (VH dB − VV dB) for rows r0..r1."""
        from .radar import to_linear

        vv, vh = (to_linear(a, self.scale) for a in self.raster.read_rows([self.vv, self.vh], r0, r1))
        with np.errstate(divide="ignore", invalid="ignore"):
            vv_db = np.where(vv > 0, 10 * np.log10(np.where(vv > 0, vv, 1)), np.nan)
            vh_db = np.where(vh > 0, 10 * np.log10(np.where(vh > 0, vh, 1)), np.nan)
        return [vv_db, vh_db, vh_db - vv_db]


RADAR_FEATURES = ["VV (dB)", "VH (dB)", "VH/VV (dB)"]


def _strip_reader(raster: Raster, bands: list[int], qa: dict | None, radar: RadarInput | None = None):
    """Reads a strip as (pixels × features of valid cells, valid mask, cells removed by QA, cells inside the boundary).
    Features are the bands, then the radar's VV, VH and VH/VV in dB when given."""
    d = len(bands) + (len(RADAR_FEATURES) if radar else 0)

    def read(st: Strip) -> tuple[np.ndarray, np.ndarray, int, int]:
        arrays = raster.read_rows(bands, st.r0, st.r1) + (radar.rows(st.r0, st.r1) if radar else [])
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

    return read


def _tally(raw: np.ndarray, valid: np.ndarray, X: np.ndarray, st: Strip, k: int, ri: int, ni: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Per-class pixel count, ground area, band sums and NDVI sum and count for one strip (raw: 0-based class per valid cell)."""
    w = valid.size // (st.r1 - st.r0)
    d = X.shape[1]
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


def _sum_tallies(parts, k: int, d: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    px, m2, sums, nd_s, nd_c = np.zeros(k), np.zeros(k), np.zeros((k, d)), np.zeros(k), np.zeros(k)
    for a, b, c, e, f in parts:  # a loop rather than np.add.reduce: exact float order and simple types
        px += a
        m2 += b
        sums += c
        nd_s += e
        nd_c += f
    return px, m2, sums, nd_s, nd_c


def _roles(bands: list[int], roles: dict) -> tuple[int, int]:
    ri = bands.index(roles["red"]) if roles.get("red") is not None and roles["red"] in bands else -1
    ni = bands.index(roles["nir"]) if roles.get("nir") is not None and roles["nir"] in bands else -1
    return ri, ni


def classify_land_cover(raster: Raster, bands: list[int], k: int, roles: dict, boundary=None, qa: dict | None = None, seed: int = 7, max_training: int = 20_000) -> dict:
    """k-means over every valid pixel, in strips: statistics, a training sample, then prediction strip by strip."""
    if not bands:
        raise ValueError("Choose at least one band.")
    if not isinstance(k, int) or k < 2 or k > len(PALETTE):
        raise ValueError(f"Choose between 2 and {len(PALETTE)} classes.")
    plan = StripPlan(raster, boundary)
    w, h, d = plan.width, plan.height, len(bands)
    read = _strip_reader(raster, bands, qa)

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
    ri, ni = _roles(bands, roles)
    classes = np.zeros((h, w), dtype=np.uint8)

    def predict(st: Strip) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        X, valid, _, _ = read(st)
        raw = km.predict((X - mean) / sd) if X.shape[0] else np.empty(0, dtype=np.int64)
        c = np.zeros(valid.size, dtype=np.uint8)
        c[valid] = raw + 1
        classes[st.rows] = c.reshape(st.r1 - st.r0, w)
        return _tally(raw, valid, X, st, k, ri, ni)

    areas_px, m2, sums, nd_s, nd_c = _sum_tallies(plan.map(predict), k, d)
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
            "iterations": int(km.n_iter_), "trainingPixels": int(train.shape[0]), "method": "kmeans", "notes": notes, "_rowArea": geo.cell_area if geo else None}


LABEL_FIELDS = ("class", "label", "landcover", "land_cover", "lc", "type", "name")


def training_labels(fc: dict, field: str | None) -> tuple[str, list[tuple[dict, str]]]:
    """The label field (given, or the first common one present) and each usable feature with its label."""
    feats = [f for f in fc.get("features", []) if (f or {}).get("geometry") and f["geometry"].get("type") in ("Polygon", "MultiPolygon", "Point", "MultiPoint")]
    if not feats:
        raise ValueError("The training file has no polygons or points.")
    fields = sorted({k for f in feats for k in (f.get("properties") or {})})
    if not field:
        field = next((c for c in LABEL_FIELDS for k in fields if k.lower() == c), None)
        field = next(k for k in fields if k.lower() == field) if field else None
    if not field or field not in fields:
        raise ValueError(f"Choose the property that holds each shape’s class. Properties in the file: {', '.join(fields) or 'none'}.")
    out = [(f, str(f["properties"][field]).strip()) for f in feats if (f.get("properties") or {}).get(field) not in (None, "")]
    if not out:
        raise ValueError(f"No training shape has a value in “{field}”.")
    return field, out


#: Forest sizes offered. Time is proportional to the number of trees. Accuracy barely changes beyond ~100 trees
#: (Probst & Boulesteix 2018). Measured on synthetic 3–6 class, 4–8 band data: 50 trees ran in half the time of 100,
#: for 0.03–0.2 percentage points of accuracy.
FOREST_SIZES = (50, 100, 200)

def classify_supervised(raster: Raster, bands: list[int], training: dict, roles: dict, label_field: str | None = None, boundary=None, qa: dict | None = None,
                        seed: int = 7, max_per_class: int = 5000, trees: int = 100, threads: int = 1, radar: RadarInput | None = None) -> dict:
    """Random forest (Breiman 2001) trained on labelled polygons or points, cross-validated by shape, applied strip by strip."""
    from affine import Affine
    from rasterio.features import rasterize
    from rasterio.warp import transform_geom
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.model_selection import StratifiedGroupKFold

    if not bands:
        raise ValueError("Choose at least one band.")
    field, shapes = training_labels(training, label_field)
    labels = sorted({lab for _, lab in shapes}, key=str.lower)
    if len(labels) < 2:
        raise ValueError("Training needs at least two classes.")
    if len(labels) > len(PALETTE):
        raise ValueError(f"Use at most {len(PALETTE)} classes ({len(labels)} found in “{field}”).")
    code = {lab: i + 1 for i, lab in enumerate(labels)}
    if not raster.meta.bbox or (not raster.meta.geographic and raster.crs is None):
        raise ValueError("Training shapes need a georeferenced raster with a coordinate reference system.")
    geoms = []
    for i, (f, lab) in enumerate(shapes):
        g = f["geometry"] if raster.meta.geographic else transform_geom("EPSG:4326", raster.crs, f["geometry"])
        geoms.append((g, code[lab], i + 1))
    plan = StripPlan(raster, boundary)
    nb = len(bands)
    w, h, d = plan.width, plan.height, nb + (len(RADAR_FEATURES) if radar else 0)
    read = _strip_reader(raster, bands, qa, radar)

    # Pass 1: pixels under the training shapes (cell centres; where shapes overlap, the later one wins).
    def gather(st: Strip) -> tuple[np.ndarray, np.ndarray, np.ndarray, int, int]:
        tr = raster.transform @ Affine.translation(0, st.r0)
        shape = (st.r1 - st.r0, w)
        y = rasterize(((g, c) for g, c, _ in geoms), out_shape=shape, transform=tr, fill=0, dtype="uint8").ravel()
        gid = rasterize(((g, i) for g, _, i in geoms), out_shape=shape, transform=tr, fill=0, dtype="int32").ravel()
        X, valid, masked, inside = read(st)
        yv, gv = y[valid], gid[valid]
        keep = yv > 0
        return X[keep], yv[keep], gv[keep], masked, inside

    parts = plan.map(gather)
    plan.check_overlap(sum(p[4] for p in parts))
    X = np.vstack([p[0] for p in parts]) if parts else np.empty((0, d))
    y = np.concatenate([p[1] for p in parts]) if parts else np.empty(0, np.uint8)
    groups = np.concatenate([p[2] for p in parts]) if parts else np.empty(0, np.int32)
    found = {int(c): int((y == c).sum()) for c in np.unique(y)}
    missing = [lab for lab in labels if found.get(code[lab], 0) == 0]
    if missing:
        raise ValueError(f"No valid pixels fall inside the training shapes for: {', '.join(missing)}. Check that the shapes lie on the image.")
    pixels_total = int(y.size)
    # Balance the classes: at most max_per_class pixels each, drawn at random.
    rng = np.random.default_rng(seed + 202)
    take = np.concatenate([idx if idx.size <= max_per_class else rng.choice(idx, size=max_per_class, replace=False) for idx in (np.flatnonzero(y == c) for c in range(1, len(labels) + 1))])
    take.sort()
    X, y, groups = X[take], y[take], groups[take]

    # Cross-validation by shape: pixels of one polygon are spatially autocorrelated, so they never split across folds.
    shapes_per_class = {lab: int(np.unique(groups[y == code[lab]]).size) for lab in labels}
    folds = min(5, *shapes_per_class.values())
    validation: dict | None = None
    if folds >= 2:
        pred = np.zeros_like(y)
        cv = StratifiedGroupKFold(n_splits=folds, shuffle=True, random_state=seed)
        for tr_i, te_i in cv.split(X, y, groups):
            m = RandomForestClassifier(n_estimators=trees, random_state=seed, n_jobs=threads).fit(X[tr_i], y[tr_i])
            pred[te_i] = m.predict(X[te_i])
        k = len(labels)
        cm = np.zeros((k, k), dtype=np.int64)
        np.add.at(cm, (pred.astype(np.int64) - 1, y.astype(np.int64) - 1), 1)  # rows: predicted, columns: reference
        table: list[list[int]] = cm.tolist()
        rows_n = [sum(r) for r in table]
        cols_n = [sum(r[j] for r in table) for j in range(k)]
        hits = [table[i][i] for i in range(k)]
        validation = {"folds": folds, "confusion": table, "overall": sum(hits) / sum(rows_n),
                      "user": [hits[i] / rows_n[i] if rows_n[i] else None for i in range(k)],
                      "producer": [hits[j] / cols_n[j] if cols_n[j] else None for j in range(k)]}
    rf = RandomForestClassifier(n_estimators=trees, random_state=seed, n_jobs=threads).fit(X, y)
    rf.n_jobs = 1  # strips already run in parallel threads (tree traversal releases the GIL)

    # Pass 2: classify every strip.
    ri, ni = _roles(bands, roles)
    k = len(labels)
    classes = np.zeros((h, w), dtype=np.uint8)

    def predict(st: Strip):
        Xs, valid, _, _ = read(st)
        raw = np.empty(Xs.shape[0], dtype=np.int64)
        for i in range(0, Xs.shape[0], 250_000):  # bounds the per-tree probability arrays
            raw[i : i + 250_000] = rf.predict(Xs[i : i + 250_000]).astype(np.int64) - 1
        c = np.zeros(valid.size, dtype=np.uint8)
        c[valid] = raw + 1
        classes[st.rows] = c.reshape(st.r1 - st.r0, w)
        return _tally(raw, valid, Xs, st, k, ri, ni)

    px, m2, sums, nd_s, nd_c = _sum_tallies(plan.map(predict), k, d)
    n = float(px.sum()) or 1.0
    geo = plan.geo
    stats = [{"id": j + 1, "label": labels[j], "pixels": int(px[j]), "ha": float(m2[j] / 10_000) if geo else None, "share": float(px[j] / n),
              "bandMeans": [float(v) for v in sums[j][:nb] / (px[j] or 1)],
              **({"radarMeans": [float(v) for v in sums[j][nb:] / (px[j] or 1)]} if radar else {}), "ndvi": float(nd_s[j] / nd_c[j]) if (ri >= 0 and ni >= 0 and nd_c[j]) else None,
              "trainingPixels": int((y == j + 1).sum()), "trainingShapes": shapes_per_class[labels[j]]} for j in range(k)]
    notes: list[str] = []
    if boundary:
        notes.append(clip_note(boundary, sum(p[4] for p in parts)))
    if qa:
        frac = sum(p[3] for p in parts) / (w * h) if w * h else 0.0
        notes.append(f"Quality mask from band {qa['band'] + 1} ({QA_KINDS[qa['kind']]['rule']}) removed {frac * 100:.1f} % of pixels.")
    features = [f"band {b + 1}" for b in bands] + (RADAR_FEATURES if radar else [])
    notes += [
        f"Random forest (Breiman 2001; scikit-learn, {trees} trees, √features per split) on {d} feature{'' if d == 1 else 's'} ({', '.join(features)}), "
        f"trained on {y.size:,} pixels from {len(shapes)} shapes labelled by “{field}” ({pixels_total:,} under the shapes; at most {max_per_class:,} per class, drawn at random).",
    ]
    if validation:
        notes.append(f"Cross-validation by shape ({folds} folds; a shape’s pixels are never split between training and test): {validation['overall'] * 100:.1f} % of held-out "
                     "training pixels classified correctly. Training shapes are chosen, not a random sample, so this is not the map’s accuracy: estimate that with a stratified sample.")
    else:
        few = [lab for lab, n_s in shapes_per_class.items() if n_s < 2]
        notes.append(f"No cross-validation: {', '.join(few)} {'has' if len(few) == 1 else 'have'} only one training shape. Draw at least two per class, apart from each other.")
    if geo:
        notes.append(geo.note)
    if raster.resample_factor > 1:
        notes.append(f"Classified on a resampled grid (each cell = {fmt(raster.resample_factor, 3)} original pixels).")
    return {"filename": raster.meta.filename, "bands": bands, "k": k, "width": w, "height": h, "classes": classes, "stats": stats, "labels": labels,
            "labelField": field, "trainingPixels": int(y.size), "validation": validation, "method": "rf", "notes": notes, "_rowArea": geo.cell_area if geo else None,
            "features": features, "radar": bool(radar)}


def land_cover_markdown(r: dict, labels: list[str]) -> str:
    rows = []
    for i, c in enumerate(r["stats"]):
        label = labels[i] if i < len(labels) and labels[i] else "—"
        area = f"{c['pixels']:,} px" if c["ha"] is None else f"{fmt(c['ha'], 4)} ha"
        nd = "—" if c["ndvi"] is None else fmt(c["ndvi"], 3)
        rows.append(f"| {c['id']} | {label} | {area} | {c['share'] * 100:.1f} % | {nd} | {' · '.join(fmt(v, 4) for v in c['bandMeans'])} |")
    rf = r.get("method") == "rf"
    what = f"random forest, {r['k']} classes from training shapes" if rf else f"{r['k']} clusters"
    out = [
        "## Dataset", "", f"- File: {r['filename']}; bands {', '.join(str(b + 1) for b in r['bands'])}; {what}", "",
        "## Results", "", "| Class | Label | Mapped area | Share | Mean NDVI | Band means |", "|---|---|---|---|---|---|", *rows, "",
    ]
    v = r.get("validation")
    if rf and v:
        names = [labels[i] if i < len(labels) and labels[i] else r["labels"][i] for i in range(r["k"])]
        out += ["### Cross-validation by training shape (pixels; rows: predicted, columns: reference)", "",
                "| | " + " | ".join(names) + " | User’s |", "|---" * (len(names) + 2) + "|"]
        for i, row in enumerate(v["confusion"]):
            ua = v["user"][i]
            out.append(f"| **{names[i]}** | " + " | ".join(f"{x:,}" for x in row) + f" | {'—' if ua is None else f'{ua * 100:.1f} %'} |")
        out += ["| **Producer’s** | " + " | ".join("—" if p is None else f"{p * 100:.1f} %" for p in v["producer"]) + f" | **{v['overall'] * 100:.1f} %** |", ""]
    out += ["## Method and limits", "", *[f"- {n}" for n in r["notes"]]]
    return "\n".join(out)
