"""Terrain: slope, aspect, hillshade, relief; hydrology (streams, watersheds) and contours."""

from __future__ import annotations

import math

import numpy as np

from ..processing.render import hex_rgb, viridis
from ..processing.rio import grid_to_lonlat, ground_geometry
from ..processing.terrain import ASPECTS, SLOPE_CLASSES, analyze_terrain, contours_geojson, flow_routing, nice_interval, stream_lines, terrain_markdown
from . import tool
from .common import boundary, clean, number, raster
from .context import ToolContext, ToolError

ORDER_COLORS = np.array([[125, 211, 252], [56, 189, 248], [14, 165, 233], [2, 132, 199], [3, 105, 161], [30, 64, 175]], dtype=float)


def _grid_rgba(grid: np.ndarray, rgb: np.ndarray) -> np.ndarray:
    out = np.zeros((*grid.shape, 4), dtype=np.uint8)
    ok = np.isfinite(grid)
    out[..., :3] = np.clip(np.round(np.nan_to_num(rgb)), 0, 255)
    out[..., 3] = np.where(ok, 255, 0)
    return out


def hillshade_rgba(hs: np.ndarray) -> np.ndarray:
    v = np.nan_to_num(hs)[..., None]
    return _grid_rgba(hs, np.concatenate([v * 235 + 10, v * 240 + 12, v * 245 + 18], axis=-1))


def slope_rgba(slope: np.ndarray) -> np.ndarray:
    colors = np.array([hex_rgb(c["color"]) for c in SLOPE_CLASSES], dtype=float)
    bounds = np.array([c["upTo"] for c in SLOPE_CLASSES])
    idx = np.minimum(len(bounds) - 1, np.searchsorted(bounds, np.nan_to_num(slope), side="right"))
    return _grid_rgba(slope, colors[idx])


def elevation_rgba(z: np.ndarray, lo: float, hi: float) -> np.ndarray:
    return _grid_rgba(z, viridis((z - lo) / ((hi - lo) or 1)).astype(float))


def flow_rgba(z: np.ndarray, hs: np.ndarray, acc: np.ndarray, order: np.ndarray, basin: np.ndarray | None = None, outlet: tuple[int, int] | None = None) -> np.ndarray:
    max_log = math.log10(max(float(acc.max()), 1))
    shade = np.where(np.isfinite(hs), hs, 0.5)[..., None]
    t = (np.log10(np.maximum(acc, 1)) / (max_log or 1))[..., None]
    rgb = np.concatenate([shade * 90 + t * 20, shade * 100 + t * 60, shade * 110 + t * 110], axis=-1)
    s = order > 0
    rgb[s] = ORDER_COLORS[np.minimum(len(ORDER_COLORS) - 1, order[s].astype(int) - 1)]
    if basin is not None:
        rgb[basin] = rgb[basin] * 0.5 + np.array([245, 184, 61]) * 0.5
    out = _grid_rgba(z, rgb)
    if outlet is not None:
        out[outlet] = [255, 255, 255, 255]
    return out


def hydrology_markdown(f: dict, valid_km2: float) -> str:
    """The report's hydrology section."""
    from ..processing.stats import fmt, thousands

    total_km = sum(f["lengthByOrder"]) / 1000
    density = fmt(total_km / valid_km2, 3) if valid_km2 > 0 else "—"
    lines = [
        "", "## Hydrology", "",
        f"- Channels: cells draining at least {fmt(f['thresholdM2'] / 1e6, 3)} km²; highest Strahler order {f['maxOrder']}; total length {fmt(total_km, 4)} km; drainage density {density} km/km².",
        *[f"- Order {i}: {fmt(l / 1000, 4)} km" for i, l in enumerate(f["lengthByOrder"]) if i > 0],
        f"- Depression filling raised {thousands(f['raisedCells'])} cells by more than 1 mm (largest {fmt(f['maxRaise'], 3)} m).",
        "- Method: Priority-Flood depression filling with an ε gradient (Barnes et al. 2014), D8 steepest-descent flow (O’Callaghan & Mark 1984), Strahler (1957) stream order. "
        "The threshold sets where channels start and is a choice, not a measurement; D8 cannot split flow, so it draws parallel lines on planar slopes.",
    ]
    return "\n".join(lines)


def watershed_line(area_m2: float, mean_elevation: float | None, mean_slope: float | None) -> str:
    from ..processing.stats import fmt

    return f"- Watershed: {fmt(area_m2 / 1e6, 4)} km² ({fmt(area_m2 / 1e4, 4)} ha), mean elevation {fmt(mean_elevation)} m, mean slope {fmt(mean_slope, 3)}°."


@tool("terrain")
def run(ctx: ToolContext, inputs: dict, params: dict) -> dict:
    r = raster(ctx, inputs, "dem")
    t = analyze_terrain(r, boundary(params))
    ctx.progress(0.6, "Rendering layers")
    e = t["elevation"]
    layers = {
        "hillshade": ctx.png("hillshade.png", hillshade_rgba(t["_hillshade"])),
        "slope": ctx.png("slope.png", slope_rgba(t["_slope"])),
        "elevation": ctx.png("elevation.png", elevation_rgba(t["_dem"], e["min"], e["max"])),
    }
    image = {"url": layers["slope"], "bounds": r.meta.latlng_bounds, "label": "Slope classes", "legend": [{"color": c["color"], "label": c["label"]} for c in SLOPE_CLASSES]} if r.meta.latlng_bounds else None
    return clean({"tool": "terrain", "name": r.meta.filename, "markdown": terrain_markdown(t, r.meta), "terrain": t, "layers": layers,
                  "suggestedInterval": nice_interval(t["relief"]), "slopeClasses": SLOPE_CLASSES, "aspects": ASPECTS, "warnings": r.meta.warnings, "map": {"bounds": r.meta.latlng_bounds, "image": image}})


@tool("hydrology")
def run_hydrology(ctx: ToolContext, inputs: dict, params: dict) -> dict:
    r = raster(ctx, inputs, "dem")
    km2 = number(params, "thresholdKm2", 0.5, 0.0001, 100000, "Set the stream threshold as a positive area in km².")
    t = analyze_terrain(r, boundary(params))
    geo: object = t["_geo"]
    ctx.progress(0.3, "Filling depressions and routing flow")
    f = flow_routing(t["_dem"], geo, km2 * 1e6)
    ctx.progress(0.75, "Tracing streams")
    ll = grid_to_lonlat(r, f["width"], f["height"])
    downloads = []
    streams = None
    if ll:
        streams = stream_lines(f, ll)
        name = f"{r.meta.filename.rsplit('.', 1)[0]}_streams.geojson"
        downloads.append(ctx.download("Export streams (GeoJSON)", name, ctx.json(name, streams), "application/geo+json"))
    np.savez_compressed(ctx.dir / "flow.npz", dir=f["dir"], acc=f["acc"], order=f["order"], dem=t["_dem"], slope=t["_slope"], hillshade=t["_hillshade"], cell=geo.cell_area)
    flow_png = ctx.png("flow.png", flow_rgba(t["_dem"], t["_hillshade"], f["acc"], f["order"]))
    stats = {k: f[k] for k in ("width", "height", "thresholdM2", "maxOrder", "lengthByOrder", "raisedCells", "maxRaise")}
    valid_km2 = float((np.isfinite(t["_dem"]) * geo.cell_area[:, None]).sum()) / 1e6
    return clean({"tool": "terrain", "name": r.meta.filename, "flow": stats, "layer": flow_png, "streams": streams, "downloads": downloads,
                  "markdown": hydrology_markdown(stats, valid_km2),
                  "demFile": inputs.get("dem"), "boundary": params.get("boundary")})


@tool("contours")
def run_contours(ctx: ToolContext, inputs: dict, params: dict) -> dict:
    r = raster(ctx, inputs, "dem")
    interval = number(params, "interval", 10, 1e-6, 1e6, "Set a positive contour interval in metres.")
    (dem,) = r.read_bands([0])
    from ..processing.zonal import clip_to_boundary

    clip_to_boundary(r, dem, boundary(params))
    ll = grid_to_lonlat(r, dem.width, dem.height)
    if not ll:
        raise ToolError("Contours need a DEM with a known coordinate reference system.")
    out = contours_geojson(dem.data.astype(np.float64), ll, interval)
    name = f"{r.meta.filename.rsplit('.', 1)[0]}_contours_{interval:g}m.geojson"
    url = ctx.json(name, out["fc"])
    return clean({"tool": "terrain", "name": r.meta.filename, "contours": {"levels": out["levels"], "lines": len(out["fc"]["features"]), "interval": interval},
                  "geojson": out["fc"], "downloads": [ctx.download("Export contours (GeoJSON)", name, url, "application/geo+json")]})
