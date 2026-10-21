"""Sentinel-1 (C-band SAR) backscatter: speckle filtering, polarisation indices and change between two dates.

Inputs are VV and VH backscatter (σ⁰ or γ⁰) GeoTIFFs, in decibels (as exported from Earth Engine's
COPERNICUS/S1_GRD) or in linear power (as in ASF's RTC products). Speckle is multiplicative, so every
average is taken in linear power and only the results are shown in dB.

- Lee (1980) filter: x̂ = x̄ + b (z − x̄), b = var(x) / var(z), var(x) = (var(z) − x̄² C_v²) / (1 + C_v²),
  with C_v² = 1 / ENL the speckle's squared coefficient of variation. ENL ≈ 4.4 for IW GRDH (ESA Sentinel-1
  Product Definition).
- Dual-polarisation radar vegetation index RVI = 4 σ⁰_VH / (σ⁰_VV + σ⁰_VH) (after Kim & van Zyl 2009,
  adapted to dual-pol; Nasirzadehdizaji et al. 2019).
- Change: the log ratio 10·log₁₀(σ⁰_after / σ⁰_before), the standard SAR change measure because speckle
  makes the difference of intensities depend on brightness (Rignot & van Zyl 1993). A drop in VH, which
  responds to volume scattering in canopies, is the usual sign of clearing.

Different orbits or incidence angles change backscatter on their own: compare images from the same relative
orbit, processed the same way.
"""

from __future__ import annotations

import numpy as np
from scipy.ndimage import uniform_filter

from .rio import Raster, same_grid
from .stats import fmt
from .tiles import Strip, StripPlan, class_totals
from .zonal import clip_note

ENL_IW_GRD = 4.4
CHANGE = {1: {"label": "Backscatter decrease", "color": [239, 68, 68]}, 2: {"label": "No significant change", "color": [148, 163, 184]}, 3: {"label": "Backscatter increase", "color": [59, 130, 246]}}


class HistStats:
    """Streaming statistics: exact n, mean, SD (float64 sums), min and max; quartiles from fixed bins of `width`.

    Each quartile is the centre of the bin holding its order statistic, so it is within width / 2 of the exact
    value (0.005 dB for the 0.01 dB bins used here), using a few kilobytes instead of a copy of every pixel.
    """

    def __init__(self, lo: float, hi: float, width: float) -> None:
        import threading

        self.lo, self.width = lo, width
        self.bins = np.zeros(round((hi - lo) / width) + 2, dtype=np.int64)  # first and last bins catch values outside
        self.n, self.s, self.ss = 0, 0.0, 0.0
        self.min, self.max = np.inf, -np.inf
        self._lock = threading.Lock()

    def add(self, v: np.ndarray) -> None:
        v = v[np.isfinite(v)]
        if not v.size:
            return
        idx = np.clip(np.floor((v.astype(np.float64) - self.lo) / self.width).astype(np.int64) + 1, 0, self.bins.size - 1)
        counts = np.bincount(idx, minlength=self.bins.size)
        x = v.astype(np.float64)
        with self._lock:
            self.bins += counts
            self.n += int(v.size)
            self.s += float(x.sum())
            self.ss += float((x * x).sum())
            self.min, self.max = min(self.min, float(v.min())), max(self.max, float(v.max()))

    def quantile(self, p: float) -> float:
        rank = (self.n - 1) * p
        i = int(np.searchsorted(np.cumsum(self.bins), rank + 1))
        mid = self.lo + (i - 0.5) * self.width
        return float(min(max(mid, self.min), self.max))

    def dict(self) -> dict | None:
        if not self.n:
            return None
        mean = self.s / self.n
        sd = float(np.sqrt(max(0.0, (self.ss - self.n * mean * mean) / (self.n - 1)))) if self.n > 1 else 0.0
        return {"n": self.n, "mean": mean, "sd": sd, "min": self.min, "max": self.max, "q1": self.quantile(0.25), "median": self.quantile(0.5), "q3": self.quantile(0.75)}


def detect_scale(r: Raster, band: int) -> str:
    """"db" when the band looks logarithmic (land backscatter in dB is mostly negative), else "linear"."""
    (o,) = r.overview([band], max_side=256)
    v = o[np.isfinite(o)]
    return "db" if v.size and float(np.median(v)) < 0 else "linear"


def to_linear(a: np.ndarray, scale: str) -> np.ndarray:
    if scale == "db":
        return np.power(10.0, a / 10.0, dtype=np.float64)
    out = a.astype(np.float64)
    out[out <= 0] = np.nan  # power cannot be zero or negative
    return out


def lee_filter(z: np.ndarray, size: int = 5, enl: float = ENL_IW_GRD) -> np.ndarray:
    """Lee (1980) speckle filter on linear power; NaN cells are left out of the local statistics."""
    if size <= 1:
        return z.copy()
    ok = np.isfinite(z)
    zz = np.where(ok, z, 0.0)
    n = uniform_filter(ok.astype(np.float64), size, mode="reflect")
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = uniform_filter(zz, size, mode="reflect") / n
        mean2 = uniform_filter(zz * zz, size, mode="reflect") / n
        var_z = np.maximum(mean2 - mean * mean, 0.0)
        cv2 = 1.0 / enl
        var_x = np.maximum((var_z - mean * mean * cv2) / (1.0 + cv2), 0.0)
        b = np.where(var_z > 0, var_x / np.where(var_z > 0, var_z, 1.0), 0.0)
    out = mean + b * (z - mean)
    out[~ok] = np.nan
    return out


def _db(a: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        return (10.0 * np.log10(a)).astype(np.float32)


def analyze_radar(images: list[Raster], vv: int, vh: int, boundary=None, size: int = 5, enl: float = ENL_IW_GRD, threshold_db: float = 3.0,
                  scale: str = "auto", display_side: int = 4096) -> dict:
    """Per-date backscatter statistics and, for two images, the VH log-ratio change map, in strips."""
    if not 1 <= len(images) <= 2:
        raise ValueError("Add one Sentinel-1 image, or two (before and after) for change.")
    for r in images:
        if max(vv, vh) >= r.meta.bands:
            raise ValueError(f"{r.meta.filename} has {r.meta.bands} band{'' if r.meta.bands == 1 else 's'}; choose the VV and VH bands.")
    if len(images) == 2 and not same_grid(images[0].meta, images[1].meta):
        raise ValueError("The two images are not on the same grid. Export both with the same region, scale and CRS (and from the same relative orbit).")
    if size < 1 or size % 2 == 0 or size > 15:
        raise ValueError("The speckle filter window must be an odd number of pixels from 1 to 15.")
    scales = [detect_scale(r, vv) if scale == "auto" else scale for r in images]
    plan = StripPlan(images[0], boundary)
    w, h, geo = plan.width, plan.height, plan.geo
    halo = size // 2
    k = max(1, -(-max(w, h) // display_side))
    two = len(images) == 2
    change = np.zeros((h, w), dtype=np.uint8) if two else None
    def db() -> HistStats:
        return HistStats(-60.0, 40.0, 0.01)

    bufs = [{"vv": db(), "vh": db(), "ratio": db(), "rvi": HistStats(0.0, 4.0, 0.0005)} for _ in images]
    ratio_buf = db() if two else None

    def work(st: Strip):
        e0, e1 = max(0, st.r0 - halo), min(h, st.r1 + halo)
        m = plan.mask(e0, e1)
        filt = []
        for r, sc in zip(images, scales, strict=True):
            a_vv, a_vh = r.read_rows([vv, vh], e0, e1)
            lin = [to_linear(a, sc) for a in (a_vv, a_vh)]
            if m is not None:
                for a in lin:
                    a[~m] = np.nan
            filt.append([lee_filter(a, size, enl)[st.r0 - e0 : st.r1 - e0] for a in lin])
        inside = int(m[st.r0 - e0 : st.r1 - e0].sum()) if m is not None else 0
        out: dict = {"inside": inside, "views": []}
        for i, (f_vv, f_vh) in enumerate(filt):
            ok = np.isfinite(f_vv) & np.isfinite(f_vh)
            bufs[i]["vv"].add(_db(f_vv[ok]))
            bufs[i]["vh"].add(_db(f_vh[ok]))
            bufs[i]["ratio"].add(_db(f_vh[ok] / f_vv[ok]))
            bufs[i]["rvi"].add((4 * f_vh[ok] / (f_vv[ok] + f_vh[ok])).astype(np.float32))
        sel = np.flatnonzero((np.arange(st.r0, st.r1) % k) == 0)
        last = filt[-1]
        out["views"] = [(st.r0 + int(j), _db(last[0][j, ::k]), _db(last[1][j, ::k])) for j in sel]
        if two and change is not None and ratio_buf is not None:
            with np.errstate(divide="ignore", invalid="ignore"):
                d = 10.0 * np.log10(filt[1][1] / filt[0][1])  # VH log ratio, after / before
            ok = np.isfinite(d)
            c = np.zeros(d.shape, dtype=np.uint8)
            c[ok] = 2
            c[ok & (d <= -threshold_db)] = 1
            c[ok & (d >= threshold_db)] = 3
            change[st.rows] = c
            ratio_buf.add(d[ok].astype(np.float32))
        return out

    parts = plan.map(work)
    inside = sum(p["inside"] for p in parts)
    plan.check_overlap(inside)
    rows = sorted((row for p in parts for row in p["views"]), key=lambda x: x[0])
    view_vv = np.vstack([r[1] for r in rows]) if rows else np.zeros((0, 0), np.float32)
    view_vh = np.vstack([r[2] for r in rows]) if rows else np.zeros((0, 0), np.float32)
    dates = []
    for i, r in enumerate(images):
        dates.append({"name": r.meta.filename, "scale": scales[i], **{key: b.dict() for key, b in bufs[i].items()}})
    result: dict = {"width": w, "height": h, "dates": dates, "views": {"vv": view_vv, "vh": view_vh}, "filter": {"size": size, "enl": enl}, "thresholdDb": threshold_db}
    if two and change is not None and ratio_buf is not None:
        counts, areas = class_totals(change, geo.cell_area if geo else None, 4, plan.row_blocks())
        valid = int(counts[1:].sum())
        result["change"] = {"classes": change, "counts": {str(c): int(counts[c]) for c in (1, 2, 3)},
                            "ha": {str(c): float(areas[c] / 1e4) for c in (1, 2, 3)} if areas is not None else None,
                            "share": {str(c): float(counts[c] / valid) if valid else 0.0 for c in (1, 2, 3)},
                            "logRatio": ratio_buf.dict()}
    notes = [
        f"Speckle: Lee (1980) filter, {size} × {size} window, ENL {fmt(enl, 3)} (Sentinel-1 IW GRDH ≈ 4.4), computed in linear power; statistics are reported in dB.",
        "Inputs were read as " + ", ".join(f"{d['name']}: {'dB' if d['scale'] == 'db' else 'linear power'}" for d in dates) + (" (detected from the values)." if scale == "auto" else "."),
        "RVI = 4 σ⁰VH / (σ⁰VV + σ⁰VH), a dual-polarisation vegetation index: higher where volume scattering from canopies is strong.",
    ]
    if two:
        notes.append(f"Change: VH log ratio 10·log₁₀(after / before); ≤ −{fmt(threshold_db, 3)} dB is a decrease (the usual sign of clearing), ≥ +{fmt(threshold_db, 3)} dB an increase. "
                     "Soil moisture, rain, flooding and crop growth also move backscatter; compare images from the same season and relative orbit, and check flagged areas on optical imagery.")
    if boundary:
        notes.append(clip_note(boundary, inside))
    if geo:
        notes.append(geo.note)
    if images[0].resample_factor > 1:
        notes.append(f"Analysed on a resampled grid (each cell = {fmt(images[0].resample_factor, 3)} original pixels).")
    result["notes"] = notes
    return result


def radar_markdown(res: dict) -> str:
    def q(s: dict | None) -> str:
        return "—" if not s else f"{fmt(s['median'], 3)} ({fmt(s['q1'], 3)} to {fmt(s['q3'], 3)})"

    lines = ["## Dataset", "", *[f"- Image {i + 1}: {d['name']}" for i, d in enumerate(res["dates"])], "", "## Results", "",
             "| Image | VV dB | VH dB | VH/VV dB | RVI |", "|---|---|---|---|---|"]
    lines += [f"| {d['name']} | {q(d['vv'])} | {q(d['vh'])} | {q(d['ratio'])} | {q(d['rvi'])} |" for d in res["dates"]]
    lines += ["", "Values are medians (quartiles) over the area."]
    ch = res.get("change")
    if ch:
        lines += ["", "### Change (VH log ratio)", "", "| Class | Area | Share |", "|---|---|---|"]
        for c in ("1", "2", "3"):
            area = f"{fmt(ch['ha'][c], 4)} ha" if ch["ha"] else f"{ch['counts'][c]:,} px"
            lines.append(f"| {CHANGE[int(c)]['label']} | {area} | {ch['share'][c] * 100:.1f} % |")
        if ch["logRatio"]:
            lines += ["", f"Median log ratio {fmt(ch['logRatio']['median'], 3)} dB (quartiles {fmt(ch['logRatio']['q1'], 3)} to {fmt(ch['logRatio']['q3'], 3)})."]
    lines += ["", "## Method and limits", "", *[f"- {n}" for n in res["notes"]]]
    return "\n".join(lines)
