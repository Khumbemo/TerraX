"""Sentinel-2 L2A windows from Earth Search and Sentinel-1 RTC windows from the Planetary Computer, stored as new GeoTIFF uploads."""

from __future__ import annotations

import tempfile
from pathlib import Path

from .. import storage
from ..services.live import S1Item, StacItem, read_s1_window, read_s2_window, sas_token
from . import tool
from .context import ToolContext, ToolError


@tool("sentinel")
def run(ctx: ToolContext, inputs: dict, params: dict) -> dict:
    item_d = params.get("item")
    bbox = params.get("bbox")
    if not isinstance(item_d, dict) or not item_d.get("id"):
        raise ToolError("Choose a scene first.")
    if not isinstance(bbox, list) or len(bbox) != 4:
        raise ToolError("The area to read is missing.")
    item = StacItem.from_public(item_d)
    ctx.progress(0.1, "Reading Sentinel-2 bands from Earth Search")
    with tempfile.TemporaryDirectory(dir=storage.root()) as tmp:
        out = Path(tmp) / f"{storage.safe_name(item.id)}.tif"
        notes = read_s2_window(item, [float(v) for v in bbox], out)
        ctx.progress(0.9, "Storing the scene")
        f = storage.save_file(out.name, out, owner=ctx.owner)
    return {"file": f.public(), "notes": notes}


@tool("sentinel1")
def run_s1(ctx: ToolContext, inputs: dict, params: dict) -> dict:
    item_d = params.get("item")
    bbox = params.get("bbox")
    if not isinstance(item_d, dict) or not item_d.get("id"):
        raise ToolError("Choose a scene first.")
    if not isinstance(bbox, list) or len(bbox) != 4:
        raise ToolError("The area to read is missing.")
    item = S1Item.from_public(item_d)
    match = ctx.file(str(inputs["match"])) if inputs.get("match") else None
    if match is not None and match.kind != "raster":
        raise ToolError("The image to match is not a GeoTIFF.")
    ctx.progress(0.05, "Getting a data token from the Planetary Computer")
    token = sas_token()
    ctx.progress(0.15, "Reading VV and VH from the Planetary Computer")
    with tempfile.TemporaryDirectory(dir=storage.root()) as tmp:
        out = Path(tmp) / f"{storage.safe_name(item.id)}.tif"
        notes = read_s1_window(item, [float(v) for v in bbox], out, token, match.path if match else None)
        orbit = params.get("matchOrbit")
        if match is not None and isinstance(orbit, (int, float)) and item.relative_orbit is not None and int(orbit) != item.relative_orbit:
            notes.append(f"The first image is from relative orbit {int(orbit)} and this one from {item.relative_orbit}: the viewing geometry differs, "
                         "which changes backscatter on its own. Prefer scenes from the same relative orbit for change.")
        ctx.progress(0.9, "Storing the scene")
        f = storage.save_file(out.name, out, owner=ctx.owner)
    return {"file": f.public(), "notes": notes}
