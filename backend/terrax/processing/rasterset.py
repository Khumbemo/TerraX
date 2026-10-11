"""One analysed raster layer (a band or a spectral index): statistics, histogram,
preview and report; plus multi-date series with a trend test."""

from __future__ import annotations

from typing import Any

import numpy as np

from .dates import date_from_filename, decimal_year
from .indices import IndexPlan, index_def, plan_index
from .render import PREVIEW_MAX_SIDE
from .report import format_bytes
from .rio import QA_KINDS, Raster, qa_masked, same_grid
from .stats import ValueBuffer, fmt, fmt_p, histogram_large, summarize_large, trend_test
from .tiles import Strip, StripPlan
from .zonal import clip_note


def _valid_qa(view: dict, bands: int) -> dict | None:
    qa = view.get("qa")
    return qa if qa and 0 <= int(qa.get("band", -1)) < bands and qa.get("kind") in ("scl", "landsat") else None


class _Layer:
    """One band or spectral index of a raster, readable for any rows (QA mask applied)."""

    def __init__(self, r: Raster, view: dict):
        self.r = r
        self.qa = _valid_qa(view, r.meta.bands)
        self.notes: list[str] = []
        if view.get("mode") == "index":
            self.index: IndexPlan | None = plan_index(r, view["index"], view.get("bands") or {})
            self.notes = list(self.index.notes)
            self.view = {"mode": "index", "index": view["index"], "bands": view.get("bands") or {}, "qa": self.qa}
        else:
            self.index = None
            band = int(view.get("band", 0))
            self.band = band if 0 <= band < r.meta.bands else 0
            self.view = {"mode": "band", "band": self.band, "qa": self.qa}

    def rows(self, r0: int, r1: int) -> tuple[np.ndarray, int]:
        """Values of rows r0..r1 and how many cells the quality mask removed."""
        a = self.index.rows(self.r, r0, r1) if self.index else self.r.read_rows([self.band], r0, r1)[0]
        masked = 0
        if self.qa:
            m = qa_masked(self.qa["kind"], self.r.read_rows([self.qa["band"]], r0, r1)[0])
            a[m] = np.nan
            masked = int(m.sum())
        return a, masked


def _gather(r: Raster, layer: _Layer, boundary=None, with_preview: bool = False) -> tuple[np.ndarray, np.ndarray | None, int, int]:
    """Finite values of a layer (float32), its preview grid, cells masked by QA and cells inside the boundary."""
    plan = StripPlan(r, boundary)
    w, h = plan.width, plan.height
    pv = pys = pxs = None
    if with_preview:
        sv = min(1.0, PREVIEW_MAX_SIDE / max(h, w))
        ph, pw = max(1, round(h * sv)), max(1, round(w * sv))
        pys = np.minimum(h - 1, (np.arange(ph) / sv).astype(int))
        pxs = np.minimum(w - 1, (np.arange(pw) / sv).astype(int))
        pv = np.full((ph, pw), np.nan, dtype=np.float32)
    collected = ValueBuffer(w * h)

    def work(st: Strip) -> tuple[int, int]:
        a, masked = layer.rows(st.r0, st.r1)
        inside = 0
        if st.inside is not None:
            a[~st.inside] = np.nan
            inside = int(st.inside.sum())
        if pv is not None and pys is not None and pxs is not None:
            sel = np.flatnonzero((pys >= st.r0) & (pys < st.r1))
            if sel.size:
                pv[sel] = a[pys[sel] - st.r0][:, pxs]
        collected.add(a[np.isfinite(a)])
        return masked, inside

    parts = plan.map(work)
    inside = sum(p[1] for p in parts)
    plan.check_overlap(inside)
    return collected.values, pv, sum(p[0] for p in parts), inside


def dataset(r: Raster, view: dict, boundary=None) -> tuple[dict, np.ndarray]:
    """Statistics, histogram and hints of one layer, read in strips at full resolution; also returns its preview grid."""
    layer = _Layer(r, view)
    w, h = r.gw, r.gh
    vals, pv, masked, inside = _gather(r, layer, boundary, with_preview=True)
    assert pv is not None
    hints: list[str] = []
    if boundary:
        hints.append(clip_note(boundary, inside))
    if layer.qa:
        frac = masked / (w * h) if w * h else 0.0
        layer.notes.append(f"Quality mask from band {layer.qa['band'] + 1} ({QA_KINDS[layer.qa['kind']]['rule']}) removed {frac * 100:.1f} % of pixels.")
    hints += layer.notes
    s = summarize_large(vals)
    view = layer.view
    warnings = list(r.meta.warnings)
    if not s:
        warnings.append("Every pixel is empty or marked as no-data.")
    if s and view["mode"] == "band":
        if s.min >= -1 and s.max <= 1:
            hints.append("Values lie between −1 and 1, consistent with a normalised index such as NDVI.")
        elif r.meta.bands >= 2 and s.min >= 0 and s.max <= 12000:
            hints.append("Values look like surface reflectance scaled by 10,000 (as in Sentinel-2 L2A). Choose a spectral index to derive NDVI, NDWI, NDMI and others.")
    m = r.meta
    ds = {
        "kind": "raster", "filename": m.filename, "sizeBytes": m.size_bytes, "width": m.width, "height": m.height, "bands": m.bands, "view": view,
        "noData": m.nodata, "stats": s.dict() if s else None, "validPixels": int(vals.size), "totalPixels": int(w * h),
        "statsResampled": r.resample_factor > 1, "histogram": histogram_large(vals, s.min, s.max, 30) if s else [], "bbox": m.bbox, "epsg": m.epsg,
        "latLngBounds": m.latlng_bounds, "pixelSize": m.pixel_size, "hints": hints, "warnings": warnings, "bandNames": m.band_names,
    }
    return ds, pv


def _num_text(v: float) -> str:
    return str(int(v)) if float(v).is_integer() and abs(v) < 1e21 else repr(float(v))


def _crs_text(ds: dict) -> str:
    crs = f"EPSG:{ds['epsg']}" if ds["epsg"] else "unknown"
    px = ds["pixelSize"]
    return crs + (f"; pixel size {fmt(px[0])} × {fmt(px[1])} (CRS units)" if px else "")


def raster_report(ds: dict) -> str:
    s = ds["stats"]
    v = ds["view"]
    layer = f"{index_def(v['index']).name} computed from the assigned bands" if v["mode"] == "index" else f"band {v['band'] + 1} of {ds['bands']}"
    b = ds["latLngBounds"]
    lines = ["## Dataset", "", f"- File: {ds['filename']} (GeoTIFF, {format_bytes(ds['sizeBytes'])})",
             f"- Size: {ds['width']} × {ds['height']} pixels, {ds['bands']} band{'' if ds['bands'] == 1 else 's'}; analysed layer: {layer}",
             f"- CRS: {_crs_text(ds)}",
             f"- Extent (WGS84): {b[0][0]:.4f}° to {b[1][0]:.4f}° N, {b[0][1]:.4f}° to {b[1][1]:.4f}° E" if b else "- Extent: not available in WGS84",
             f"- No-data value: {_num_text(ds['noData']) if ds['noData'] is not None else 'none declared'}; valid pixels {ds['validPixels']:,} of {ds['totalPixels']:,} ({ds['validPixels'] / max(1, ds['totalPixels']) * 100:.1f} %)",
             "", "## Results", ""]
    if s:
        lines += ["| Statistic | Value |", "|---|---|", f"| Mean ± SD | {fmt(s['mean'])} ± {fmt(s['sd'])} |", f"| Median (IQR) | {fmt(s['median'])} ({fmt(s['q1'])}–{fmt(s['q3'])}) |",
                  f"| Range | {fmt(s['min'])} to {fmt(s['max'])} |", ""]
        if v["mode"] == "index" and v["index"] == "ndvi":
            bins = ds["histogram"]
            share = lambda lo, hi: sum(x["count"] for x in bins if lo <= (x["x0"] + x["x1"]) / 2 < hi)
            total = max(1, ds["validPixels"])
            lines += [f"Approximate NDVI cover (from histogram bins; indicative USGS ranges): below 0.2: {share(-np.inf, 0.2) / total * 100:.1f} %, 0.2–0.6: {share(0.2, 0.6) / total * 100:.1f} %, 0.6 and above: {share(0.6, np.inf) / total * 100:.1f} %.", ""]
    else:
        lines += ["No valid pixels.", ""]
    lines += [f"- {h}" for h in ds["hints"]]
    return "\n".join(lines)


# ── Multi-date series ────────────────────────────────────────────────────────

MIN_VALID = 0.2


def analyze_stack(rasters: list[Raster], index: str | None, bands: dict, qa: dict | None = None, boundary=None) -> dict:
    if len(rasters) < 2:
        raise ValueError("Add at least two images from different dates.")
    found = [(r, date_from_filename(r.meta.filename)) for r in rasters]
    undated = [r.meta.filename for r, d in found if d is None]
    if undated:
        raise ValueError(f"No date found in: {', '.join(undated)}. Put the acquisition date in each file name (for example S2_2024-03-15_ndvi.tif or LC09_20240315.tif).")
    dated = sorted(((r, d) for r, d in found if d is not None), key=lambda x: x[1])
    notes = []
    if not all(same_grid(rasters[0].meta, r.meta) for r in rasters):
        notes.append("The images are not all on the same grid, so each value covers a slightly different area. Export every date with the same region, scale and CRS for a like-for-like series.")
    label = index_def(index).short if index else "Band 1"
    rows: list[dict[str, Any]] = []
    for r, when in dated:
        multi = r.meta.bands > 1
        view: dict[str, Any] = {"mode": "index", "index": index, "bands": bands} if index and multi else {"mode": "band", "band": 0}
        if qa and multi:
            view["qa"] = qa
        vals, _, _, _ = _gather(r, _Layer(r, view), boundary)
        st = summarize_large(vals)
        cells = r.gw * r.gh
        frac = vals.size / cells if cells else 0.0
        rows.append({"filename": r.meta.filename, "date": when, "mean": st.mean if st else None,
                     "median": st.median if st else None, "validFraction": frac, "sparse": frac < MIN_VALID})
    used = [x for x in rows if not x["sparse"] and x["mean"] is not None]
    trend = trend_test([decimal_year(x["date"]) for x in used], [x["mean"] for x in used])
    if index and any(r.meta.bands == 1 for r in rasters):
        notes.append(f"Single-band files were read as {label} directly.")
    if any(x["sparse"] for x in rows):
        notes.append(f"Images with under {MIN_VALID * 100:g} % valid pixels (clouds, no data or outside the boundary) are listed but left out of the trend.")
    if not trend:
        notes.append("At least four usable dates are needed for a trend test.")
    notes.append("Each date is summarised by the mean over its valid pixels. Mixing seasons, sensors or cloud amounts changes which pixels are averaged, so compare images from the same season (or use a seasonal test on a long series).")
    return {"label": label, "rows": [{**x, "date": x["date"].isoformat()} for x in rows], "trend": trend.dict() if trend else None, "notes": notes}


def stack_markdown(r: dict) -> str:
    t = r["trend"]
    rows = r["rows"]
    p = lambda v: f"p {fmt_p(v)}" if fmt_p(v).startswith("<") else f"p = {fmt_p(v)}"
    return "\n".join([
        "## Dataset", "", f"- {len(rows)} images, {rows[0]['date']} to {rows[-1]['date']}; value: {r['label']}", "", "## Results", "",
        "| Date | File | Mean | Median | Valid pixels |", "|---|---|---|---|---|",
        *[f"| {x['date']} | {x['filename']} | {fmt(x['mean'])} | {fmt(x['median'])} | {x['validFraction'] * 100:.0f} %{' (excluded)' if x['sparse'] else ''} |" for x in rows], "",
        f"Trend (Mann–Kendall, n = {t['n']}): {t['direction']}, Theil–Sen slope {fmt(t['senSlope'])} per year, {p(t['p'])}." if t else "Trend: not tested (fewer than four usable dates).",
        "", "## Method and limits", "", *[f"- {n}" for n in r["notes"]],
    ])
