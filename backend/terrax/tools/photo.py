"""Space & aerial photos: vegetation cover (ExG + Otsu), VARI, EXIF and comparison."""

from __future__ import annotations

import numpy as np

from ..processing.photo import analyze_photo, photo_map, photo_markdown
from . import tool
from .common import clean
from .context import ToolContext, ToolError


def _mask_rgba(rgba: np.ndarray, mask: np.ndarray) -> np.ndarray:
    out = rgba.copy()
    out[mask] = (out[mask] * 0.35 + np.array([52, 211, 153, 255]) * 0.65).astype(np.uint8)
    return out


@tool("photo")
def run(ctx: ToolContext, inputs: dict, params: dict) -> dict:
    f = ctx.file(inputs.get("photo"))
    if f is None:
        raise ToolError("Choose a JPG, PNG or WebP photo.")
    p = analyze_photo(f.path, f.name)
    other = ctx.file(inputs.get("other"))
    q = analyze_photo(other.path, other.name) if other else None
    views = {"photo": ctx.png("photo.png", p["_rgba"]), "vegetation": ctx.png("vegetation.png", _mask_rgba(p["_rgba"], p["_mask"]))}
    if q:
        views["other"] = ctx.png("other.png", q["_rgba"])
        views["otherVegetation"] = ctx.png("other_vegetation.png", _mask_rgba(q["_rgba"], q["_mask"]))
    return clean({"tool": "photo", "name": f.name + (f" vs {other.name}" if other else ""), "markdown": photo_markdown(p, q), "photo": p, "other": q,
                  "views": views, "map": photo_map([x for x in (p, q) if x])})
