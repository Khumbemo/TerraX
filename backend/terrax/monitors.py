"""Forest-loss monitoring: an area is re-checked as new Sentinel-2 scenes arrive, and its owner is e-mailed new loss.

A monitor keeps, in ``<storage>/monitors/<id>/`` (and the bucket, with object storage):

* ``reference.tif``: NDVI of a cloud-free median composite of the clearest recent scenes (services.live.composite_s2),
  built when the monitor is created. Forest is NDVI ≥ `forestNdvi` (0.5) on it.
* ``state.npz``: per pixel, whether a drop is pending confirmation (and since which scene date), confirmed, or already
  reported.

Each check reads the scenes published since the last one, oldest first, onto the reference grid with their own cloud
mask (SCL). A clear forest pixel whose NDVI is at least `drop` (0.2) below the reference is a candidate. A candidate
is confirmed when the pixel's next clear observation is a candidate too (a clear observation that is not resets it;
cloudy ones do not count), the two-observation rule of the GLAD and RADD forest alerts, which removes most single-scene
false alarms from undetected cloud, haze and shadow. Confirmed pixels form patches; a patch of at least `minAreaHa`
(0.5 ha) becomes an alert, stored with its polygons and e-mailed to the owner.

With `radar` on (the default), Sentinel-1 RTC scenes are used too, since cloud can hide the ground from Sentinel-2 for
weeks in the monsoon. A radar reference, ``radar_reference.tif``, is the median VH backscatter (dB) of the scenes of the
same 120 days, each read onto the reference grid and speckle-filtered (Lee 1980); a forest pixel whose VH in a new
scene is at least `vhDrop` (3 dB) below it is a radar candidate. Clearing removes the canopy's volume scattering, so
VH usually falls. Each sensor keeps its own pending state, and a radar drop is confirmed only by the next radar
observation (an optical one only by the next clear optical one), so speckle cannot confirm or cancel an optical
detection, nor the reverse. Confirmed loss from either sensor becomes an alert. This is a simple threshold on a
reference, not RADD's probabilistic method (Reiche et al. 2021); `vhDrop` is a setting, not a calibrated value, and
wet or dry canopies, flooding and different orbits also move VH.

What the method cannot tell apart: harvest, fire, storm and clearing alike are loss; a strong seasonal drop (leaf-off,
drought) beyond the threshold is not excluded, so the reference should come from the season being monitored and be
rebuilt when it no longer matches (the API can rebuild it).

References: Hansen MC et al. (2016) Humid tropical forest disturbance alerts using Landsat data. Environmental Research
Letters 11: 034008 (GLAD alerts). Reiche J et al. (2021) Forest disturbance alerts for the Congo Basin using Sentinel-1.
Environmental Research Letters 16: 024005 (RADD alerts).
"""

from __future__ import annotations

import logging
import shutil
import time
import uuid
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
from sqlalchemy import delete, func, select, update

from . import db, mailer, objectstore, storage

log = logging.getLogger("terrax.monitors")

DEFAULTS: dict[str, float] = {"forestNdvi": 0.5, "drop": 0.2, "minAreaHa": 0.5, "maxCloud": 40, "checkHours": 24, "radar": 1, "vhDrop": 3.0}
LIMITS: dict[str, tuple[float, float]] = {"forestNdvi": (0.1, 0.95), "drop": (0.05, 1.0), "minAreaHa": (0.01, 1000), "maxCloud": (1, 100), "checkHours": (6, 24 * 30),
                                          "radar": (0, 1), "vhDrop": (0.5, 15)}
RADAR_REFERENCE_SCENES = 10  # the most recent Sentinel-1 scenes of the reference period, for the median VH
REFERENCE_DAYS = 120  # the reference composite uses scenes from this many days before the monitor is created
REFERENCE_SCENES = 6
SCENES_PER_CHECK = 8
MAX_SIDE_KM = 14  # Sentinel-2 windows are read at 10 m, at most 1,500 pixels a side


class MonitorError(ValueError):
    """A monitor cannot be created or checked as asked (the message says why)."""


def settings_from(raw: dict[str, Any] | None) -> dict[str, float]:
    out = dict(DEFAULTS)
    for k, v in (raw or {}).items():
        if k not in LIMITS:
            continue
        try:
            x = float(v)
        except (TypeError, ValueError):
            raise MonitorError(f"“{k}” must be a number.") from None
        lo, hi = LIMITS[k]
        if not lo <= x <= hi:
            raise MonitorError(f"Set “{k}” between {lo:g} and {hi:g}.")
        out[k] = x
    return out


def area_of(geojson: dict) -> tuple[dict, list[float]]:
    """The polygons of a FeatureCollection (or one geometry) and their WGS84 bounding box; refused when too large."""
    from pyproj import Geod
    from shapely.geometry import shape

    feats: list[dict[str, Any]] = (geojson.get("features") or []) if geojson.get("type") == "FeatureCollection" else [{"type": "Feature", "properties": {}, "geometry": geojson}]
    polys = [f for f in feats if isinstance(f, dict) and (f.get("geometry") or {}).get("type") in ("Polygon", "MultiPolygon")]
    if not polys:
        raise MonitorError("Draw or upload the area to watch as polygons.")
    shapes = [shape(f["geometry"]) for f in polys]
    w = min(s.bounds[0] for s in shapes)
    s_ = min(s.bounds[1] for s in shapes)
    e = max(s.bounds[2] for s in shapes)
    n = max(s.bounds[3] for s in shapes)
    if not (-180 <= w < e <= 180 and -90 <= s_ < n <= 90):
        raise MonitorError("The area is not in longitude/latitude (WGS84).")
    geod = Geod(ellps="WGS84")
    width = geod.inv(w, (s_ + n) / 2, e, (s_ + n) / 2)[2] / 1000
    height = geod.inv((w + e) / 2, s_, (w + e) / 2, n)[2] / 1000
    if max(width, height) > MAX_SIDE_KM:
        raise MonitorError(f"The area is {width:.1f} × {height:.1f} km; watch areas up to {MAX_SIDE_KM} km across (or split a larger one).")
    return {"type": "FeatureCollection", "features": polys}, [w, s_, e, n]


# ── Rows ─────────────────────────────────────────────────────────────────────


def public(m: dict[str, Any], alerts: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    out = {"id": m["id"], "name": m["name"], "geojson": m["geojson"], "bbox": m["bbox"], "settings": m["settings"], "email": m["email"], "active": m["active"],
           "reference": m["reference"], "lastScene": m["last_scene"], "lastChecked": m["last_checked"], "nextCheck": m["next_check"], "status": m["status"],
           "created": m["created"]}
    if alerts is not None:
        out["alerts"] = alerts
    return out


def alert_public(a: dict[str, Any], with_geojson: bool = False) -> dict[str, Any]:
    out = {"id": a["id"], "created": a["created"], "firstSeen": a["first_seen"], "confirmed": a["confirmed"], "areaHa": a["area_ha"], "patches": a["patches"],
           "emailed": a["emailed"]}
    if with_geojson:
        out["geojson"] = a["geojson"]
    return out


def create(owner: str, name: str, geojson: dict, raw_settings: dict | None, email: bool = True, now: float | None = None) -> dict[str, Any]:
    now = now or time.time()
    fc, bbox = area_of(geojson)
    name = (name or "").strip()[:200] or "Watched area"
    row = {"id": uuid.uuid4().hex, "owner": owner, "name": name, "geojson": fc, "bbox": bbox, "settings": settings_from(raw_settings), "email": bool(email),
           "active": True, "reference": None, "last_scene": None, "last_checked": None, "next_check": now, "status": "Building the reference image…",
           "created": now, "updated": now}
    with db.connect() as c:
        c.execute(db.monitors.insert().values(**row))
    return row


def get(mid: str) -> dict[str, Any]:
    with db.connect() as c:
        m = db.row(c.execute(select(db.monitors).where(db.monitors.c.id == mid)).first())
    if m is None:
        raise KeyError(mid)
    return m


def owned(mid: str, owner: str) -> dict[str, Any]:
    m = get(mid)
    if m["owner"] != owner:
        raise KeyError(mid)
    return m


def list_for(owner: str) -> list[dict[str, Any]]:
    with db.connect() as c:
        ms = [m for m in (db.row(r) for r in c.execute(select(db.monitors).where(db.monitors.c.owner == owner).order_by(db.monitors.c.created.desc()))) if m]
        counts: dict[str, int] = {str(k): int(v) for k, v in c.execute(select(db.monitor_alerts.c.monitor_id, func.count())
                                                                         .where(db.monitor_alerts.c.monitor_id.in_([m["id"] for m in ms]))
                                                                         .group_by(db.monitor_alerts.c.monitor_id))}
    return [public(m) | {"alertCount": int(counts.get(m["id"], 0))} for m in ms]


def alerts_of(mid: str, with_geojson: bool = False) -> list[dict[str, Any]]:
    with db.connect() as c:
        rows = [db.row(r) for r in c.execute(select(db.monitor_alerts).where(db.monitor_alerts.c.monitor_id == mid).order_by(db.monitor_alerts.c.created.desc()))]
    return [alert_public(a, with_geojson) for a in rows if a]


def change(mid: str, **values: Any) -> None:
    with db.connect() as c:
        c.execute(update(db.monitors).where(db.monitors.c.id == mid).values(updated=time.time(), **values))


def remove(mid: str) -> None:
    with db.connect() as c:
        c.execute(delete(db.monitor_alerts).where(db.monitor_alerts.c.monitor_id == mid))
        c.execute(delete(db.monitors).where(db.monitors.c.id == mid))
    shutil.rmtree(_folder(mid), ignore_errors=True)
    if objectstore.enabled():
        objectstore.delete_tree(f"monitors/{mid}")


def due(now: float | None = None) -> list[str]:
    now = now or time.time()
    with db.connect() as c:
        return [r[0] for r in c.execute(select(db.monitors.c.id).where(db.monitors.c.active.is_(True), db.monitors.c.next_check <= now))]


# ── Files ────────────────────────────────────────────────────────────────────


def _folder(mid: str) -> Path:
    return storage.root() / "monitors" / storage.check_id(mid)


def _local(mid: str, name: str) -> Path | None:
    p = _folder(mid) / name
    if not p.exists() and objectstore.enabled():
        objectstore.download(f"monitors/{mid}/{name}")
    return p if p.exists() else None


def _saved(path: Path) -> None:
    if objectstore.enabled():
        objectstore.upload(path)


def _load_state(mid: str, shape: tuple[int, int]) -> dict[str, np.ndarray]:
    fresh = {"pending": np.zeros(shape, dtype=bool), "since": np.zeros(shape, dtype=np.int32), "confirmed": np.zeros(shape, dtype=bool),
             "reported": np.zeros(shape, dtype=bool), "r_pending": np.zeros(shape, dtype=bool), "r_since": np.zeros(shape, dtype=np.int32),
             "by_radar": np.zeros(shape, dtype=bool)}
    p = _local(mid, "state.npz")
    if p is not None:
        with np.load(p) as z:
            fresh.update({k: z[k] for k in z.files})
    return fresh


def _save_state(mid: str, state: dict[str, np.ndarray]) -> None:
    p = _folder(mid) / "state.npz"
    np.savez_compressed(p, pending=state["pending"], since=state["since"], confirmed=state["confirmed"], reported=state["reported"],
                        r_pending=state["r_pending"], r_since=state["r_since"], by_radar=state["by_radar"])
    _saved(p)


# ── Scenes (module-level so tests can stand in for the live catalogue) ──────


def search_scenes(bbox: list[float], start: str, end: str, max_cloud: float) -> list[Any]:
    from .services import live

    body = live.stac_search_body(bbox, start, end, max_cloud, limit=50)
    return live.parse_stac_items(live.fetch_json(f"{live.EARTH_SEARCH}/search", method="POST", body=body))


def read_scene(item: Any, bbox: list[float], out: Path) -> list[str]:
    from .services import live

    return live.read_s2_window(item, bbox, out)


def composite(items: list[Any], bbox: list[float], out: Path, workdir: Path) -> dict[str, Any]:
    from .services import live

    return live.composite_s2(items, bbox, out, workdir, read=read_scene)


def search_radar(bbox: list[float], start: str, end: str) -> list[Any]:
    from .services import live

    body = live.s1_search_body(bbox, start, end, limit=50)
    return live.parse_s1_items(live.fetch_json(f"{live.PC_STAC}/search", method="POST", body=body))


def read_radar(item: Any, bbox: list[float], out: Path, match: Path) -> list[str]:
    """VV and VH (linear power) of a Sentinel-1 RTC scene, read onto the reference grid."""
    from .services import live

    return live.read_s1_window(item, bbox, out, live.sas_token(), match=match)


def _vh_db(path: Path) -> np.ndarray:
    """VH of a scene file (band 2, linear power) speckle-filtered (Lee 1980, 5 × 5) and in dB."""
    import rasterio

    from .processing.radar import lee_filter

    with rasterio.open(path) as ds:
        vh = ds.read(2).astype(np.float64)
    vh[~np.isfinite(vh) | (vh <= 0)] = np.nan
    with np.errstate(divide="ignore", invalid="ignore"):
        db = 10 * np.log10(lee_filter(vh))
    return np.where(np.isfinite(db), db, np.nan).astype(np.float32)


def build_radar_reference(m: dict[str, Any], start: str, end: str) -> str:
    """The median VH (dB) of the most recent Sentinel-1 scenes of the reference period, on the reference grid."""
    import tempfile

    import rasterio

    folder = _folder(m["id"])
    ref = folder / "reference.tif"
    try:
        items = sorted(search_radar(m["bbox"], start, end), key=lambda i: i.datetime, reverse=True)[:RADAR_REFERENCE_SCENES]
    except (ValueError, OSError) as err:
        return f" Radar: the Sentinel-1 catalogue could not be searched ({err}); optical scenes only for now."
    stack, dates = [], []
    with tempfile.TemporaryDirectory(dir=storage.root()) as tmp:
        for item in items:
            path = Path(tmp) / f"{storage.safe_name(item.id)}.tif"
            try:
                read_radar(item, m["bbox"], path, ref)
            except ValueError:
                continue
            stack.append(_vh_db(path))
            dates.append(item.datetime)
    if len(stack) < 2:
        return " Radar: fewer than two Sentinel-1 scenes in the reference period, so radar is not used."
    with np.errstate(all="ignore"):
        median = np.nanmedian(np.stack(stack), axis=0).astype(np.float32)
    with rasterio.open(ref) as src:
        profile = src.profile | {"count": 1, "dtype": "float32", "nodata": np.nan}
    out = folder / "radar_reference.tif"
    with rasterio.open(out, "w", **profile) as dst:
        dst.write(median, 1)
        dst.set_band_description(1, "reference VH (dB)")
    _saved(out)
    dates.sort()
    reference = dict(m["reference"] or {}) | {"radar": {"scenes": len(stack), "dates": [d[:10] for d in dates], "last": dates[-1]}}
    change(m["id"], reference=reference)
    m["reference"] = reference
    return f" Radar reference from {len(stack)} Sentinel-1 scenes ({dates[0][:10]} to {dates[-1][:10]})."


# ── Checking ─────────────────────────────────────────────────────────────────


def _ndvi(red: np.ndarray, nir: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        v = (nir - red) / (nir + red)
    return np.where(np.isfinite(v), v, np.nan).astype(np.float32)


def _day(iso: str) -> int:
    return date.fromisoformat(iso[:10]).toordinal()


def build_reference(m: dict[str, Any], now: float) -> str:
    """The reference NDVI from the clearest scenes of the last REFERENCE_DAYS days; returns the status message."""
    import rasterio

    end = datetime.fromtimestamp(now, UTC).date()
    start = end - timedelta(days=REFERENCE_DAYS)
    items = sorted(search_scenes(m["bbox"], start.isoformat(), end.isoformat(), m["settings"]["maxCloud"]), key=lambda i: (i.cloud if i.cloud is not None else 100))
    if len(items) < 2:
        return (f"Waiting for scenes: fewer than two Sentinel-2 scenes under {m['settings']['maxCloud']:g} % cloud between {start} and {end} "
                "for the reference image. TerraX tries again at the next check.")
    chosen = items[:REFERENCE_SCENES]
    folder = _folder(m["id"])
    folder.mkdir(parents=True, exist_ok=True)
    import tempfile

    with tempfile.TemporaryDirectory(dir=storage.root()) as tmp:
        comp = Path(tmp) / "composite.tif"
        info = composite(chosen, m["bbox"], comp, Path(tmp))
        with rasterio.open(comp) as src:
            ndvi = _ndvi(src.read(3).astype(np.float32), src.read(4).astype(np.float32))
            profile = src.profile | {"count": 1, "dtype": "float32", "nodata": np.nan}
    ref = folder / "reference.tif"
    with rasterio.open(ref, "w", **profile) as dst:
        dst.write(ndvi, 1)
        dst.set_band_description(1, "reference NDVI")
    _saved(ref)
    (folder / "state.npz").unlink(missing_ok=True)
    newest = max(i.datetime for i in items)  # later scenes are the ones to watch
    reference = {"scenes": info["scenes"], "dates": info["dates"], "built": now}
    change(m["id"], reference=reference, last_scene=newest)
    m.update(last_scene=newest, reference=reference)
    (folder / "radar_reference.tif").unlink(missing_ok=True)
    radar = build_radar_reference(m, start.isoformat(), end.isoformat()) if m["settings"].get("radar", 0) else ""
    return f"Reference built from {len(info['scenes'])} scenes ({info['dates'][0]} to {info['dates'][-1]}).{radar} Watching for new scenes."


def _on_grid(path: Path, ref, band: int, nearest: bool) -> np.ndarray:
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.warp import reproject

    with rasterio.open(path) as ds:
        if ds.crs == ref.crs and ds.transform == ref.transform and (ds.width, ds.height) == (ref.width, ref.height):
            return ds.read(band).astype(np.float32)
        dst = np.full((ref.height, ref.width), np.nan, dtype=np.float32)
        reproject(ds.read(band).astype(np.float32), dst, src_transform=ds.transform, src_crs=ds.crs, src_nodata=np.nan, dst_transform=ref.transform,
                  dst_crs=ref.crs, dst_nodata=np.nan, resampling=Resampling.nearest if nearest else Resampling.bilinear)
        return dst


def check(mid: str, now: float | None = None) -> dict[str, Any]:
    """One check of a monitor: the reference first if it has none, then every new scene. Returns the new alerts."""
    now = now or time.time()
    m = get(mid)
    alerts: list[dict[str, Any]] = []
    try:
        if not m["reference"] or _local(mid, "reference.tif") is None:
            status = build_reference(m, now)
        else:
            status, alerts = _check_scenes(m, now)
    except Exception as err:  # recorded on the monitor; the next check tries again
        log.exception("monitor %s check failed", mid)
        status = f"The last check failed ({type(err).__name__}: {err}). TerraX tries again at the next check."
    change(mid, status=status[:500], last_checked=now, next_check=now + m["settings"]["checkHours"] * 3600)
    return {"status": status, "alerts": alerts}


def _check_scenes(m: dict[str, Any], now: float) -> tuple[str, list[dict[str, Any]]]:
    import tempfile

    import rasterio

    from .processing.patches import label_patches, patch_areas, patches_to_geojson
    from .processing.rio import Raster, ground_geometry, qa_masked
    from .processing.zonal import boundary_in_crs, rows_mask

    s = m["settings"]
    since = m["last_scene"] or ""
    start = since[:10] or datetime.fromtimestamp(now - 30 * 86400, UTC).date().isoformat()
    end = datetime.fromtimestamp(now, UTC).date().isoformat()
    items = sorted((i for i in search_scenes(m["bbox"], start, end, s["maxCloud"]) if i.datetime > since), key=lambda i: i.datetime)[:SCENES_PER_CHECK]
    # Radar, when on and its reference exists: the Sentinel-1 scenes since the last one looked at.
    radar_info = (m["reference"] or {}).get("radar") or {}
    radar_ref_path = _local(m["id"], "radar_reference.tif") if s.get("radar", 0) and radar_info else None
    radar_since = radar_info.get("last", "")
    radar_items: list[Any] = []
    radar_note = ""
    if radar_ref_path is not None:
        try:
            radar_items = sorted((i for i in search_radar(m["bbox"], radar_since[:10] or start, end) if i.datetime > radar_since), key=lambda i: i.datetime)[:SCENES_PER_CHECK]
        except (ValueError, OSError) as err:
            radar_note = f" Radar not checked: the Sentinel-1 catalogue could not be searched ({err})."
    if not items and not radar_items:
        return f"No new scenes under {s['maxCloud']:g} % cloud since {since[:10] or start}.{radar_note}", []
    scenes = sorted([("optical", i) for i in items] + [("radar", i) for i in radar_items], key=lambda t: t[1].datetime)
    ref_path = _local(m["id"], "reference.tif")
    assert ref_path is not None
    ref_r = Raster(ref_path, "reference.tif", max_pixels=10**9)
    with rasterio.open(ref_path) as ref:
        ref_ndvi = ref.read(1)
        grid = ref
        ref_vh = None
        if radar_ref_path is not None:
            with rasterio.open(radar_ref_path) as rr:
                ref_vh = rr.read(1)
        inside = rows_mask(ref_r, boundary_in_crs(ref_r, {"geojson": m["geojson"]}), 0, ref.height)
        geo = ground_geometry(ref_r.meta, ref.width, ref.height)
        state = _load_state(m["id"], ref_ndvi.shape)
        forest = inside & np.isfinite(ref_ndvi) & (ref_ndvi >= s["forestNdvi"])
        cell_rows = geo.cell_area if geo else np.ones(ref.height)
        new_alerts: list[dict[str, Any]] = []
        read = {"optical": 0, "radar": 0}
        skipped: list[str] = []
        with tempfile.TemporaryDirectory(dir=storage.root()) as tmp:
            for kind, item in scenes:
                path = Path(tmp) / f"{storage.safe_name(item.id)}.tif"
                try:
                    if kind == "optical":
                        read_scene(item, m["bbox"], path)
                    else:
                        read_radar(item, m["bbox"], path, ref_path)
                except ValueError as err:
                    skipped.append(f"{item.id} ({err})")
                    if kind == "optical":
                        since = max(since, item.datetime)
                    else:
                        radar_since = max(radar_since, item.datetime)
                    continue
                read[kind] += 1
                today = _day(item.datetime)
                if kind == "optical":
                    red, nir = _on_grid(path, grid, 3, False), _on_grid(path, grid, 4, False)
                    clear = forest & ~qa_masked("scl", _on_grid(path, grid, 5, True)) & np.isfinite(red) & np.isfinite(nir)
                    drop = clear & (_ndvi(red, nir) - ref_ndvi <= -s["drop"]) & ~state["reported"]
                    pend, when = "pending", "since"
                else:
                    assert ref_vh is not None
                    vh = _vh_db(path)
                    clear = forest & np.isfinite(vh) & np.isfinite(ref_vh)  # radar sees through cloud
                    with np.errstate(invalid="ignore"):
                        drop = clear & (vh - ref_vh <= -s["vhDrop"]) & ~state["reported"]
                    pend, when = "r_pending", "r_since"
                # Two observations in a row from the same sensor: a clear one that is not low resets that sensor's
                # candidate; cloudy (optical) observations keep it.
                confirm = drop & state[pend]
                state[when] = np.where(drop & ~state[pend], today, state[when])
                state[pend] = (state[pend] & ~clear) | drop
                if kind == "radar":
                    state["by_radar"] |= confirm & ~state["confirmed"]
                state["confirmed"] |= confirm
                state["pending"] &= ~state["confirmed"]
                state["r_pending"] &= ~state["confirmed"]
                # Patches of confirmed, unreported loss; those of at least minAreaHa become an alert.
                labels, n = label_patches(state["confirmed"] & ~state["reported"])
                if n:
                    area = patch_areas(labels, n, cell_rows) / 1e4
                    big = np.flatnonzero(area >= s["minAreaHa"])
                    big = big[big > 0]
                    if big.size:
                        keep = np.zeros(n + 1, dtype=bool)
                        keep[big] = True
                        hit = keep[labels]
                        starts = np.where(state["since"] > 0, state["since"], np.iinfo(np.int32).max)
                        starts = np.minimum(starts, np.where(state["r_since"] > 0, state["r_since"], np.iinfo(np.int32).max))
                        first_day = int(starts[hit].min()) if hit.any() else np.iinfo(np.int32).max
                        first = date.fromordinal(first_day).isoformat() if first_day < np.iinfo(np.int32).max else item.datetime[:10]
                        radar_share = float(state["by_radar"][hit].mean()) if hit.any() else 0.0
                        sensors = "Sentinel-1 radar" if radar_share > 0.5 else "Sentinel-2" if radar_share == 0 else "Sentinel-2 and Sentinel-1"
                        lab = np.where(hit, labels, 0)
                        fc = patches_to_geojson(lab, n, area, ref_r, lambda i, a: {"patch": i, "area_ha": round(a, 4)})
                        feats: dict[str, Any] = fc["fc"] if fc else {"type": "FeatureCollection", "features": []}
                        for f in feats.get("features", []):
                            if isinstance(f, dict):
                                f.setdefault("properties", {})["sensors"] = sensors
                        new_alerts.append(_alert(m, first, item.datetime[:10], float(area[big].sum()), int(big.size), feats, now, sensors))
                        state["reported"] |= hit
                if kind == "optical":
                    since = max(since, item.datetime)
                    change(m["id"], last_scene=since)
                else:
                    radar_since = max(radar_since, item.datetime)
                    reference = dict(m["reference"] or {})
                    reference["radar"] = dict(reference.get("radar") or {}) | {"last": radar_since}
                    change(m["id"], reference=reference)
                    m["reference"] = reference
                _save_state(m["id"], state)
    pending_ha = float(((state["pending"] | state["r_pending"]) * cell_rows[:, None]).sum()) / 1e4
    looked = [f"{read['optical']} new scene{'s' if read['optical'] != 1 else ''} up to {since[:10]}"]
    if radar_items:
        looked.append(f"{read['radar']} radar scene{'s' if read['radar'] != 1 else ''} up to {radar_since[:10]}")
    msg = f"Checked {' and '.join(looked)}: "
    msg += (f"{len(new_alerts)} new alert{'s' if len(new_alerts) != 1 else ''} ({sum(a['areaHa'] for a in new_alerts):.2f} ha)." if new_alerts else "no new confirmed loss.")
    if pending_ha:
        msg += f" {pending_ha:.2f} ha awaits confirmation by the next clear scene."
    if skipped:
        msg += f" Could not read: {'; '.join(skipped)[:150]}."
    return msg + radar_note, new_alerts


def _alert(m: dict[str, Any], first: str, confirmed: str, area_ha: float, patches: int, fc: dict, now: float, sensors: str = "Sentinel-2") -> dict[str, Any]:
    row = {"id": uuid.uuid4().hex, "monitor_id": m["id"], "created": now, "first_seen": first, "confirmed": confirmed, "area_ha": area_ha, "patches": patches,
           "geojson": fc, "emailed": False}
    with db.connect() as c:
        c.execute(db.monitor_alerts.insert().values(**row))
    if m["email"] and mailer.can_send():
        from .auth import get_user

        user = get_user(m["owner"]) or {}
        try:
            mailer.send(str(user.get("email") or ""), f"TerraX: new forest loss in {m['name']}",
                        f"TerraX found new forest loss in “{m['name']}”: {area_ha:.2f} ha in {patches} patch{'es' if patches != 1 else ''}.\n\n"
                        f"Found by {sensors}: first seen on {first}, confirmed on {confirmed} by two observations in a row from the same satellite "
                        f"(Sentinel-2: NDVI at least {m['settings']['drop']:g} below the reference; Sentinel-1: VH backscatter at least "
                        f"{m['settings'].get('vhDrop', DEFAULTS['vhDrop']):g} dB below it).\n\n"
                        f"Open TerraX to see the patches on the map and download them: {mailer.link('/')}\n\n"
                        "Alerts come from satellite images and should be checked on finer imagery or in the field before action is taken.")
            row["emailed"] = True
            with db.connect() as c:
                c.execute(update(db.monitor_alerts).where(db.monitor_alerts.c.id == row["id"]).values(emailed=True))
        except RuntimeError as err:
            log.warning("alert e-mail for monitor %s not sent: %s", m["id"], err)
    return alert_public(row)


def check_due(now: float | None = None) -> int:
    """Checks every active monitor whose time has come (the hourly task); returns how many were checked."""
    ids = due(now)
    for mid in ids:
        check(mid, now)
    return len(ids)
