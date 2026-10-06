"""Sentinel-2 L2A window from Earth Search, stored as a new GeoTIFF upload."""

from __future__ import annotations

import tempfile
from pathlib import Path

from .. import storage
from ..services.live import StacItem, read_s2_window
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
        f = storage.save_file(out.name, out)
    return {"file": f.public(), "notes": notes}
