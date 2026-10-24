"""Terrain: slope, aspect, hillshade, relief; hydrology (streams, watersheds) and contours."""

from __future__ import annotations

import math

import numpy as np

from ..config import settings
from ..processing.render import hex_rgb, ramp_rgba, viridis
from ..processing.rio import Ground, grid_to_lonlat_arrays
from ..processing.terrain import ASPECTS, CONTOUR_TOLERANCE, SLOPE_CLASSES, analyze_terrain, contours_geojson, flow_routing, nice_interval, stream_lines, terrain_markdown
from . import tool
from .common import DISPLAY_SIDE, begin_tiles, boundary, clean, display_grid, finish_tiles, grid_crs, number, raster, save_npz
from .context import ToolContext, ToolError

WETNESS_COLORS = ["#f6efd2", "#a6cee3", "#3a87c0", "#0b3b78"]  # dry → wet
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


def flow_png(ctx_dir, name: str, z: np.ndarray, shade: np.ndarray, acc: np.ndarray, order: np.ndarray, basin: np.ndarray | None = None, outlet: tuple[int, int] | None = None) -> None:
    """Saves the flow map (optionally with a watershed and its outlet) thinned to display size; shade is the hillshade already thinned by display_grid."""
    from ..processing.render import save_png

    k = max(1, -(-max(z.shape) // DISPLAY_SIDE))
    thin = lambda a: a[::k, ::k] if (a is not None and k > 1) else a
    o = (outlet[0] // k, outlet[1] // k) if outlet is not None else None
    save_png(flow_rgba(thin(z), shade, thin(acc), thin(order), thin(basin), o), ctx_dir / name)


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


MAP_STREAM_POINTS = 250_000  # vertices the browser map draws comfortably; exports keep every line


def map_streams(fc: dict) -> tuple[dict, str | None]:
    """The highest whole Strahler orders whose lines fit MAP_STREAM_POINTS vertices, and a note when lower orders are left off the map."""
    feats = fc["features"]
    points: dict[int, int] = {}
    for ft in feats:
        o = ft["properties"]["strahler"]
        points[o] = points.get(o, 0) + len(ft["geometry"]["coordinates"])
    total, lowest = 0, None
    for o in sorted(points, reverse=True):
        if total + points[o] > MAP_STREAM_POINTS:
            break
        total += points[o]
        lowest = o
    if lowest == min(points, default=None):
        return fc, None
    shown = [ft for ft in feats if lowest is not None and ft["properties"]["strahler"] >= lowest]
    tail = "the flow layer shows every channel cell and the streams export holds all lines."
    if not shown:
        note = f"The stream network ({len(feats):,} line{'s' if len(feats) != 1 else ''}) is too large to draw as lines; {tail}"
    else:
        note = f"The map draws streams of Strahler order {lowest} and above ({len(shown):,} of {len(feats):,} lines); {tail}"
    return {"type": "FeatureCollection", "features": shown}, note


def hydrology_markdown(f: dict, valid_km2: float, wetness: dict | None = None) -> str:
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
    w = (wetness or {}).get("summary")
    if w:
        lines += [
            f"- Topographic wetness index ln(a / tan β): median {fmt(w['median'], 3)} (quartiles {fmt(w['q1'], 3)}–{fmt(w['q3'], 3)}, range {fmt(w['min'], 3)} to {fmt(w['max'], 3)}).",
            "- Wetness method: D∞ flow (Tarboton 1997) splits each cell's flow between the two cells of its steepest triangular facet, so it follows divergent "
            "and planar slopes that D8 cannot. a is the upslope area per metre of contour across the flow (a plane gives its exact upslope length), tan β the steepest "
            "facet slope, floored at 0.001 on filled flats (Beven & Kirkby 1979; Sørensen et al. 2006). Streams and Strahler orders use D8, as in TauDEM, because D∞ "
            "spreads flow and gives no single channel line; clicked watersheds add the D∞ upslope dependence (the share of each cell's flow reaching the outlet).",
        ]
    return "\n".join(lines)


def watershed_line(area_m2: float, mean_elevation: float | None, mean_slope: float | None) -> str:
    from ..processing.stats import fmt

    return f"- Watershed: {fmt(area_m2 / 1e6, 4)} km² ({fmt(area_m2 / 1e4, 4)} ha), mean elevation {fmt(mean_elevation)} m, mean slope {fmt(mean_slope, 3)}°."


@tool("terrain")
def run(ctx: ToolContext, inputs: dict, params: dict) -> dict:
    r = raster(ctx, inputs, "dem", pixels=settings().dem_pixels)
    t = analyze_terrain(r, boundary(params))
    ctx.progress(0.6, "Rendering layers")
    e = t["elevation"]
    layers = {
        "hillshade": ctx.png("hillshade.png", hillshade_rgba(display_grid(t["_hillshade"]))),
        "slope": ctx.png("slope.png", slope_rgba(display_grid(t["_slope"]))),
        "elevation": ctx.png("elevation.png", elevation_rgba(display_grid(t["_dem"]), e["min"], e["max"])),
    }
    slope = t["_slope"]
    tiles = begin_tiles(ctx, "slope", slope.shape[1], slope.shape[0], r.transform, grid_crs(r), "float32", {"kind": "slope"}, nodata=float("nan")) if slope.shape == (r.gh, r.gw) else None
    if tiles is not None:
        tiles.write(0, slope.astype(np.float32, copy=False))
    tile_info = finish_tiles(ctx, tiles, "slope", r.meta.latlng_bounds)
    crs = grid_crs(r)
    downloads = []
    if crs is not None and slope.shape == (r.gh, r.gw):
        downloads.append(ctx.download("Export slope (GeoTIFF, degrees)", "slope_deg.tif",
                                      ctx.geotiff("slope_deg.tif", slope.astype(np.float32, copy=False), r.transform, crs, nodata=float("nan"), description="slope (degrees)"), "image/tiff"))
        downloads.append(ctx.download("Export hillshade (GeoTIFF)", "hillshade.tif",
                                      ctx.geotiff("hillshade.tif", np.asarray(t["_hillshade"], dtype=np.float32), r.transform, crs, nodata=float("nan"), description="hillshade (0–1)"), "image/tiff"))
    image = {"url": layers["slope"], "bounds": r.meta.latlng_bounds, "label": "Slope classes", "legend": [{"color": c["color"], "label": c["label"]} for c in SLOPE_CLASSES],
             "tiles": tile_info} if r.meta.latlng_bounds else None
    return clean({"tool": "terrain", "name": r.meta.filename, "markdown": terrain_markdown(t, r.meta), "terrain": t, "layers": layers,
                  "suggestedInterval": nice_interval(t["relief"]), "slopeClasses": SLOPE_CLASSES, "aspects": ASPECTS, "warnings": r.meta.warnings, "map": {"bounds": r.meta.latlng_bounds, "image": image},
                  "downloads": downloads})


@tool("hydrology")
def run_hydrology(ctx: ToolContext, inputs: dict, params: dict) -> dict:
    r = raster(ctx, inputs, "dem", pixels=settings().dem_pixels)
    km2 = number(params, "thresholdKm2", 0.5, 0.0001, 100000, "Set the stream threshold as a positive area in km².")
    t = analyze_terrain(r, boundary(params))
    geo: Ground = t["_geo"]
    method = params.get("method") or "d8"
    if method not in ("d8", "dinf"):
        raise ToolError("Choose D8 or D∞ for flow accumulation.")
    ctx.progress(0.3, "Filling depressions and routing flow")
    f = flow_routing(t["_dem"], geo, km2 * 1e6, dinf=method == "dinf")
    wetness = None
    twi_tif: np.ndarray | None = None  # the wetness index for its GeoTIFF export
    dinf_grids: dict = {}
    if f["dinf"] is not None:
        from ..processing.stats import summarize_large

        extra = f.pop("dinf")
        twi = extra["twi"]
        dinf_grids = {"facet": extra["facet"], "share": extra["share"]}  # for D∞ watersheds on click
        del extra
        summary = summarize_large(twi[np.isfinite(twi)])
        twi_tif = twi.astype(np.float32) if grid_crs(r) is not None and twi.shape == (r.gh, r.gw) else None
        view = display_grid(twi)
        lo, hi = (float(v) for v in np.nanpercentile(view, [2, 98])) if np.isfinite(view).any() else (0.0, 1.0)
        wetness = {"layer": ctx.png("wetness.png", ramp_rgba(view, lo, hi, WETNESS_COLORS)), "summary": summary.dict() if summary else None,
                   "range": [lo, hi], "colors": WETNESS_COLORS}
        del twi, view
    ctx.progress(0.75, "Tracing streams")
    ll = grid_to_lonlat_arrays(r, f["width"], f["height"])
    downloads = []
    streams = None
    if ll:
        streams = stream_lines(f, ll)
        name = f"{r.meta.filename.rsplit('.', 1)[0]}_streams.geojson"
        downloads.append(ctx.download("Export streams (GeoJSON)", name, ctx.json(name, streams), "application/geo+json"))
    # After the streams, whose button the web app addresses by position.
    crs = grid_crs(r)
    if crs is not None and f["acc"].shape == (r.gh, r.gw):
        acc = np.where(np.isfinite(t["_dem"]), f["acc"], np.nan).astype(np.float32)
        downloads.append(ctx.download("Export flow accumulation (GeoTIFF, upslope area m², D8)", "flow_accumulation_m2.tif",
                                      ctx.geotiff("flow_accumulation_m2.tif", acc, r.transform, crs, nodata=float("nan"), description="upslope area (m²), D8"), "image/tiff"))
        del acc
    if twi_tif is not None:
        downloads.append(ctx.download("Export wetness index (GeoTIFF, TWI, D∞)", "twi.tif",
                                      ctx.geotiff("twi.tif", twi_tif, r.transform, crs, nodata=float("nan"), description="topographic wetness index ln(a / tan β), D∞"), "image/tiff"))
        del twi_tif
    # Kept for watershed clicks; accumulation as float32 is ample for finding the outlet, and the hillshade only feeds the image.
    shade = display_grid(t["_hillshade"])
    save_npz(ctx.dir / "flow.npz", {"dir": f["dir"], "acc": f["acc"].astype(np.float32), "order": f["order"], "dem": t["_dem"], "slope": t["_slope"], "shade": shade, "cell": geo.cell_area,
                                    **dinf_grids})
    flow_png(ctx.dir, "flow.png", t["_dem"], shade, f["acc"], f["order"])
    flow_url = ctx.url("flow.png")
    stats = {k: f[k] for k in ("width", "height", "thresholdM2", "maxOrder", "lengthByOrder", "raisedCells", "maxRaise")}
    valid_km2 = float(np.isfinite(t["_dem"]).sum(axis=1) @ geo.cell_area) / 1e6
    notes = []
    if streams is not None:
        streams, note = map_streams(streams)
        notes += [note] if note else []
    out = clean({"tool": "terrain", "name": r.meta.filename, "flow": stats, "layer": flow_url, "downloads": downloads, "notes": notes,
                 "wetness": wetness, "method": method, "markdown": hydrology_markdown(stats, valid_km2, wetness),
                 "demFile": inputs.get("dem"), "boundary": params.get("boundary")})
    out["streams"] = streams  # finite, rounded coordinates already; walking them through clean() is slow on large networks
    return out


@tool("contours")
def run_contours(ctx: ToolContext, inputs: dict, params: dict) -> dict:
    r = raster(ctx, inputs, "dem", pixels=settings().dem_pixels)
    interval = number(params, "interval", 10, 1e-6, 1e6, "Set a positive contour interval in metres.")
    (dem,) = r.read_bands([0])
    from ..processing.zonal import clip_to_boundary

    clip_to_boundary(r, dem, boundary(params))
    ll = grid_to_lonlat_arrays(r, dem.width, dem.height)
    if not ll:
        raise ToolError("Contours need a DEM with a known coordinate reference system.")
    try:
        out = contours_geojson(dem.data.astype(np.float64), ll, interval)
    except ValueError as e:
        raise ToolError(str(e)) from None
    name = f"{r.meta.filename.rsplit('.', 1)[0]}_contours_{interval:g}m.geojson"
    url = ctx.json(name, out["fc"])
    grid = f"the DEM resampled, each cell = {r.resample_factor:.3g} original pixels; TERRAX_DEM_PIXELS sets the limit" if r.resample_factor > 1 else "full resolution"
    notes = [f"Contours were traced on a {dem.width}×{dem.height} grid ({grid}) and simplified to within {CONTOUR_TOLERANCE:g} cell of the traced line (Douglas–Peucker)."]
    return clean({"tool": "terrain", "name": r.meta.filename, "contours": {"levels": out["levels"], "lines": len(out["fc"]["features"]), "interval": interval, "points": out["points"]},
                  "geojson": out["fc"], "notes": notes, "downloads": [ctx.download("Export contours (GeoJSON)", name, url, "application/geo+json")]})
