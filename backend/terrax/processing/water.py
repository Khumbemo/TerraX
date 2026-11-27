"""Surface water and floods: optical water indices or Sentinel-1 backscatter, split by an automatic threshold.

Optical (one date, or two on the same grid):
* MNDWI = (Green − SWIR1) / (Green + SWIR1) (Xu 2006) when a SWIR1 band is given, else NDWI = (Green − NIR) /
  (Green + NIR) (McFeeters 1996). MNDWI separates water from built-up land better; both are positive over open water.
* Clouds are removed with the scene's own mask (Sentinel-2 SCL or Landsat QA_PIXEL) when one is named.

Radar (Sentinel-1, one date or before/after on the same grid): calm open water reflects the radar pulse away from the
sensor, so it is dark. Backscatter (VV by default) is speckle-filtered (Lee 1980) in linear power and converted to dB.
With a date before the event, flood is water after that was not water before *and* whose backscatter fell by at least
`drop_db` (3 dB), so permanent water and steadily dark surfaces are not counted.

Thresholds: Otsu's method (1979) on the histogram, as in automatic flood mapping (e.g. Martinis et al. 2015). Otsu
always returns a split, even when a scene has almost no water, so it is used only when the histogram is bimodal: a
two-component Gaussian mixture fitted to the values has components clearly apart (Ashman's D ≥ 2; Ashman et al. 1994)
and the threshold is plausible (index −0.3 to 0.3; VV −24 to −12 dB). Otherwise the standard value is used (index 0;
VV −18 dB) and the report says so; either can be set by hand. (D must come from fitted components: the two halves of
a single bell curve cut at Otsu's threshold are about 2.6 apart, which would wrongly pass.)

References: McFeeters SK (1996) Int. J. Remote Sensing 17: 1425–1432. Xu H (2006) Int. J. Remote Sensing 27: 3025–3033.
Otsu N (1979) IEEE Trans. Systems, Man and Cybernetics 9: 62–66. Ashman KM, Bird CM, Zepf SE (1994) Astronomical
Journal 108: 2348–2361. Martinis S, Kersten J, Twele A (2015) ISPRS J. Photogrammetry and Remote Sensing 104: 203–212.
Lee JS (1980) IEEE Trans. Pattern Analysis and Machine Intelligence 2: 165–168.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from .stats import fmt

INDEX_RANGE = (-0.3, 0.3)
INDEX_DEFAULT = 0.0
SAR_RANGE = (-24.0, -12.0)
SAR_DEFAULT = -18.0

ONE_DATE = [{"id": 1, "label": "Land", "color": [120, 110, 90]}, {"id": 2, "label": "Water", "color": [40, 110, 230]}]
TWO_DATES = [
    {"id": 1, "label": "Dry both dates", "color": [120, 110, 90]},
    {"id": 2, "label": "Water both dates", "color": [20, 60, 160]},
    {"id": 3, "label": "New water (flood)", "color": [60, 200, 255]},
    {"id": 4, "label": "Water gone", "color": [230, 160, 60]},
]


def otsu(values: np.ndarray, bins: int = 256) -> float:
    """Otsu's (1979) threshold: the bin edge that maximises the between-class variance. When several edges tie (an
    empty gap between two peaks, as in clean water/land histograms), the middle of the tied run is taken rather than
    its first edge, which would sit against one of the peaks."""
    lo, hi = float(values.min()), float(values.max())
    if not hi > lo:
        return hi
    hist, edges = np.histogram(values, bins=bins, range=(lo, hi))
    hist = hist.astype(np.float64)
    i = np.arange(bins)
    wb = np.cumsum(hist)
    sb = np.cumsum(i * hist)
    wf = wb[-1] - wb
    with np.errstate(divide="ignore", invalid="ignore"):
        between = wb * wf * (sb / wb - (sb[-1] - sb) / wf) ** 2
    between[(wb == 0) | (wf == 0)] = 0
    if between.max() <= 0:
        return float(edges[bins // 2])
    best = np.flatnonzero(between >= between.max() * (1 - 1e-12))
    return float((edges[best[0] + 1] + edges[best[-1] + 1]) / 2)


def ashman_d(values: np.ndarray) -> float:
    """Ashman's D of a two-component Gaussian mixture fitted to the values: √2 |μ₁ − μ₂| / √(σ₁² + σ₂²); ≥ 2 means
    the histogram is bimodal (the components are clearly apart)."""
    from sklearn.mixture import GaussianMixture

    x = values.reshape(-1, 1)
    if x.shape[0] > 200_000:
        x = x[np.random.default_rng(0).choice(x.shape[0], 200_000, replace=False)]
    gm = GaussianMixture(n_components=2, random_state=0).fit(x)
    m = gm.means_.ravel()
    v = gm.covariances_.reshape(-1)
    s = float(np.sqrt(v.sum()))
    return float(np.sqrt(2) * abs(m[0] - m[1]) / s) if s > 0 else float("inf")


def auto_threshold(values: np.ndarray, plausible: tuple[float, float], default: float, unit: str) -> tuple[float, str]:
    """Otsu's threshold when the histogram splits cleanly and plausibly, else `default`; with a sentence for the report."""
    v = values[np.isfinite(values)]
    if v.size < 100:
        return default, f"Too few valid pixels for an automatic threshold: the standard {fmt(default)}{unit} was used."
    if v.size > 2_000_000:
        v = np.random.default_rng(0).choice(v, 2_000_000, replace=False)  # the histogram is the same to within its bins
    thr = otsu(v)
    d = ashman_d(v)
    if d >= 2 and plausible[0] <= thr <= plausible[1]:
        return float(thr), f"Threshold {fmt(thr, 3)}{unit} by Otsu's method; the two classes are clearly apart (Ashman's D = {fmt(d, 3)})."
    why = (f"Otsu's threshold ({fmt(thr, 3)}{unit}) is outside the plausible {fmt(plausible[0])} to {fmt(plausible[1])}{unit}" if d >= 2
           else f"the histogram is not clearly bimodal (Ashman's D = {fmt(d, 3)} < 2: probably little water, or mixed pixels)")
    return default, f"The standard threshold {fmt(default)}{unit} was used: {why}."


def water_index(bands: dict[str, np.ndarray]) -> tuple[np.ndarray, str]:
    """MNDWI with a SWIR1 band, else NDWI; and its name."""
    g = bands["green"].astype(np.float64)
    other, name = (bands["swir1"], "MNDWI") if "swir1" in bands else (bands["nir"], "NDWI")
    o = other.astype(np.float64)
    with np.errstate(divide="ignore", invalid="ignore"):
        v = (g - o) / (g + o)
    return np.where(np.isfinite(v), v, np.nan), name


def classify(water_a: np.ndarray, valid_a: np.ndarray, water_b: np.ndarray | None = None, valid_b: np.ndarray | None = None,
             extra_b: np.ndarray | None = None) -> np.ndarray:
    """Class codes: one date 1 land, 2 water; two dates 1 dry, 2 water both, 3 new water, 4 water gone; 0 not observed.
    `extra_b` further limits new water (radar: the backscatter drop)."""
    if water_b is None or valid_b is None:
        return np.where(valid_a, np.where(water_a, 2, 1), 0).astype(np.uint8)
    both = valid_a & valid_b
    new = water_b & ~water_a if extra_b is None else water_b & ~water_a & extra_b
    cls = np.where(water_a & water_b, 2, np.where(new, 3, np.where(water_a & ~water_b, 4, 1)))
    return np.where(both, cls, 0).astype(np.uint8)


def summarise(cls: np.ndarray, cell_area_rows: np.ndarray | None, two: bool) -> dict[str, Any]:
    legend = TWO_DATES if two else ONE_DATE
    out: dict[str, Any] = {"observedPixels": int((cls > 0).sum()), "classes": []}
    for c in legend:
        m = cls == c["id"]
        ha = float((m * cell_area_rows[:, None]).sum()) / 1e4 if cell_area_rows is not None else None
        out["classes"].append({"id": c["id"], "label": c["label"], "pixels": int(m.sum()), "ha": ha})
    return out


def water_markdown(r: dict[str, Any], bodies_md: str | None = None) -> str:
    unit = "ha" if r["summary"]["classes"][0]["ha"] is not None else "pixels"
    rows = [f"| {c['label']} | {fmt(c['ha'], 4) if c['ha'] is not None else c['pixels']} |" for c in r["summary"]["classes"]]
    lines = ["## Dataset", "", *[f"- {d}" for d in r["dates"]], "",
             "## Results", "", f"| Class | Area ({unit}) |", "|---|---|", *rows]
    if bodies_md:
        lines += ["", f"### Water bodies{' on the later date' if len(r['dates']) > 1 else ''}", "", bodies_md]
    q = r.get("quality")
    if q:
        lines += ["", f"### Water quality indicators ({q['source']}, interior water pixels)", "",
                  "| Index | What it indicates | 10th percentile | Median | 90th percentile |", "|---|---|---|---|---|"]
        for key, label, what in (("ndti", "NDTI", "turbidity (suspended sediment)"), ("ndci", "NDCI", "chlorophyll-a (phytoplankton)")):
            s = q.get(key)
            if s:
                lines.append(f"| {label} | {what} | {s['p10']:.3f} | {s['median']:.3f} | {s['p90']:.3f} |")
        lines += ["", "Relative indicators for comparing places and dates, not concentrations; see the limits below."]
    lines += ["", "## Method and limits", "", *[f"- {n}" for n in r["notes"]]]
    return "\n".join(lines)
