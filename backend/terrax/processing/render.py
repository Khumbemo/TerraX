"""Pictures for the map and reports: class maps, colour ramps and composites (PNG)."""

from __future__ import annotations

import io
from pathlib import Path

import numpy as np
from PIL import Image

from .stats import quantile_sorted

#: Viridis (perceptually uniform, colour-blind safe), 11 stops from matplotlib's definition.
VIRIDIS = ["#440154", "#482475", "#414487", "#355f8d", "#2a788e", "#21918c", "#22a884", "#44bf70", "#7ad151", "#bddf26", "#fde725"]
_STOPS = np.array([[int(h[i : i + 2], 16) for i in (1, 3, 5)] for h in VIRIDIS], dtype=float)
PREVIEW_MAX_SIDE = 512


def hex_rgb(h: str) -> tuple[int, int, int]:
    return int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16)


def viridis(t: np.ndarray) -> np.ndarray:
    """Viridis colours for values in 0…1; NaN (no data) maps to the low end and is made transparent by the caller."""
    x = np.clip(np.nan_to_num(np.asarray(t, dtype=float), nan=0.0), 0, 1) * (len(_STOPS) - 1)
    i = np.minimum(len(_STOPS) - 2, np.floor(x).astype(int))
    f = (x - i)[..., None]
    return np.round(_STOPS[i] + (_STOPS[i + 1] - _STOPS[i]) * f).astype(np.uint8)


def ramp_rgba(data: np.ndarray, vmin: float, vmax: float, colors: list[str] | None = None) -> np.ndarray:
    """RGBA for a value grid with viridis (or a custom ramp); NaN is transparent."""
    rng = (vmax - vmin) or 1.0
    t = (data - vmin) / rng
    if colors:
        stops = np.array([hex_rgb(c) for c in colors], dtype=float)
        x = np.clip(np.nan_to_num(t), 0, 1) * (len(stops) - 1)
        i = np.minimum(len(stops) - 2, np.floor(x).astype(int))
        rgb = np.round(stops[i] + (stops[i + 1] - stops[i]) * (x - i)[..., None]).astype(np.uint8)
    else:
        rgb = viridis(np.nan_to_num(t))
    a = np.where(np.isfinite(data), 255, 0).astype(np.uint8)
    return np.dstack([rgb, a])


def classes_rgba(classes: np.ndarray, palette: dict[int, tuple[int, int, int]], alpha: int = 230) -> np.ndarray:
    """RGBA for a class grid; class 0 (and unknown classes) are transparent."""
    out = np.zeros((*classes.shape, 4), dtype=np.uint8)
    for c, rgb in palette.items():
        m = classes == c
        out[m, :3] = rgb
        out[m, 3] = alpha
    return out


def composite_rgba(bands: list[np.ndarray], stretch: tuple[float, float] = (0.02, 0.98)) -> tuple[np.ndarray, list[tuple[float, float]]]:
    """RGB composite with a per-channel percentile stretch; NaN in any channel is transparent."""
    ranges = []
    chans = []
    valid = np.ones(bands[0].shape, dtype=bool)
    for b in bands:
        v = np.sort(b[np.isfinite(b)])
        lo, hi = (quantile_sorted(v, stretch[0]), quantile_sorted(v, stretch[1])) if v.size else (0.0, 1.0)
        ranges.append((lo, hi))
        chans.append(np.clip(np.round((b - lo) / ((hi - lo) or 1) * 255), 0, 255))
        valid &= np.isfinite(b)
    rgb = np.dstack([np.nan_to_num(c).astype(np.uint8) for c in chans])
    return np.dstack([rgb, np.where(valid, 255, 0).astype(np.uint8)]), ranges


def preview(data: np.ndarray, max_side: int = PREVIEW_MAX_SIDE) -> np.ndarray:
    """Nearest-neighbour downsample to at most `max_side` on the longest side."""
    h, w = data.shape[:2]
    s = min(1.0, max_side / max(h, w))
    ph, pw = max(1, round(h * s)), max(1, round(w * s))
    ys = np.minimum(h - 1, (np.arange(ph) / s).astype(int))
    xs = np.minimum(w - 1, (np.arange(pw) / s).astype(int))
    return data[ys][:, xs]


def save_png(rgba: np.ndarray, path: Path) -> Path:
    Image.fromarray(rgba, "RGBA").save(path, optimize=True)
    return path


def png_bytes(rgba: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, format="PNG", optimize=True)
    return buf.getvalue()
