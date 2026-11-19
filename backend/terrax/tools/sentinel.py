"""Sentinel-2 L2A windows from Earth Search, and Sentinel-1 RTC and Landsat Collection 2 Level-2 windows from the Planetary Computer, stored as new GeoTIFF uploads."""

from __future__ import annotations

import tempfile
from pathlib import Path

from .. import storage
from ..services.live import (
    PC_LANDSAT_SAS_TOKEN,
    S1Item,
    StacItem,
    composite_landsat,
    composite_s2,
    read_landsat_window,
    read_s1_window,
    read_s2_window,
    sas_token,
)
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


@tool("sentinel_composite")
def run_composite(ctx: ToolContext, inputs: dict, params: dict) -> dict:
    """A cloud-free median composite of several Sentinel-2 scenes (services.live.composite_s2), stored as a GeoTIFF upload."""
    items_d = params.get("items")
    bbox = params.get("bbox")
    if not isinstance(items_d, list) or not all(isinstance(d, dict) and d.get("id") for d in items_d):
        raise ToolError("Choose the scenes to combine.")
    if not isinstance(bbox, list) or len(bbox) != 4:
        raise ToolError("The area to read is missing.")
    items = [StacItem.from_public(d) for d in items_d]
    ctx.progress(0.1, f"Reading {len(items)} Sentinel-2 scenes from Earth Search")
    with tempfile.TemporaryDirectory(dir=storage.root()) as tmp:
        out = Path(tmp) / f"S2_median_{storage.safe_name(min(i.datetime[:10] for i in items))}_{storage.safe_name(max(i.datetime[:10] for i in items))}.tif"
        try:
            info = composite_s2(items, [float(v) for v in bbox], out, Path(tmp))
        except ValueError as e:
            raise ToolError(str(e)) from None
        ctx.progress(0.9, "Storing the composite")
        f = storage.save_file(out.name, out, owner=ctx.owner)
    return {"file": f.public(), "notes": info["notes"], "composite": {k: v for k, v in info.items() if k != "notes"}}


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


def _scene_and_box(params: dict) -> tuple[StacItem, list[float]]:
    item_d, bbox = params.get("item"), params.get("bbox")
    if not isinstance(item_d, dict) or not item_d.get("id"):
        raise ToolError("Choose a scene first.")
    if not isinstance(bbox, list) or len(bbox) != 4:
        raise ToolError("The area to read is missing.")
    return StacItem.from_public(item_d), [float(v) for v in bbox]


@tool("landsat")
def run_landsat(ctx: ToolContext, inputs: dict, params: dict) -> dict:
    """One Landsat Collection 2 Level-2 scene over the area (services.live.read_landsat_window), stored as a GeoTIFF upload."""
    item, bbox = _scene_and_box(params)
    ctx.progress(0.05, "Getting a data token from the Planetary Computer")
    token = sas_token(url=PC_LANDSAT_SAS_TOKEN)
    ctx.progress(0.15, "Reading Landsat bands from the Planetary Computer")
    with tempfile.TemporaryDirectory(dir=storage.root()) as tmp:
        out = Path(tmp) / f"{storage.safe_name(item.id)}.tif"
        try:
            notes = read_landsat_window(item, bbox, out, token)
        except ValueError as e:
            raise ToolError(str(e)) from None
        ctx.progress(0.9, "Storing the scene")
        f = storage.save_file(out.name, out, owner=ctx.owner)
    return {"file": f.public(), "notes": notes}


@tool("landsat_composite")
def run_landsat_composite(ctx: ToolContext, inputs: dict, params: dict) -> dict:
    """A cloud-free median composite of several Landsat scenes (services.live.composite_landsat), stored as a GeoTIFF upload."""
    items_d, bbox = params.get("items"), params.get("bbox")
    if not isinstance(items_d, list) or not all(isinstance(d, dict) and d.get("id") for d in items_d):
        raise ToolError("Choose the scenes to combine.")
    if not isinstance(bbox, list) or len(bbox) != 4:
        raise ToolError("The area to read is missing.")
    items = [StacItem.from_public(d) for d in items_d]
    ctx.progress(0.05, "Getting a data token from the Planetary Computer")
    token = sas_token(url=PC_LANDSAT_SAS_TOKEN)
    ctx.progress(0.1, f"Reading {len(items)} Landsat scenes from the Planetary Computer")
    with tempfile.TemporaryDirectory(dir=storage.root()) as tmp:
        first, last = (storage.safe_name(d) for d in (min(i.datetime[:10] for i in items), max(i.datetime[:10] for i in items)))
        out = Path(tmp) / f"Landsat_median_{first}_{last}.tif"
        try:
            info = composite_landsat(items, [float(v) for v in bbox], out, Path(tmp), token)
        except ValueError as e:
            raise ToolError(str(e)) from None
        ctx.progress(0.9, "Storing the composite")
        f = storage.save_file(out.name, out, owner=ctx.owner)
    return {"file": f.public(), "notes": info["notes"], "composite": {k: v for k, v in info.items() if k != "notes"}}
