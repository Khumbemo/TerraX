"""Live data connectors (no keys needed).

* Open-Meteo Historical Weather API (ERA5 / ERA5-Land reanalysis),
  https://open-meteo.com/en/docs/historical-weather-api
* NASA POWER daily point API (MERRA-2 / CERES), community AG,
  https://power.larc.nasa.gov/docs/services/api/temporal/daily/
* Earth Search STAC (Element 84) for Sentinel-2 L2A cloud-optimised GeoTIFFs,
  https://earth-search.aws.element84.com/v1

The server fetches the data, so the browser needs no cross-origin access.
The parsing functions are pure, so they can be tested on recorded responses.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import numpy as np

OPEN_METEO_VARS = [
    {"id": "precipitation_sum", "label": "Precipitation (mm)"},
    {"id": "temperature_2m_mean", "label": "Mean temperature (°C)"},
    {"id": "temperature_2m_max", "label": "Maximum temperature (°C)"},
    {"id": "temperature_2m_min", "label": "Minimum temperature (°C)"},
    {"id": "relative_humidity_2m_mean", "label": "Mean relative humidity (%)"},
    {"id": "et0_fao_evapotranspiration", "label": "Reference ET₀, FAO-56 (mm)"},
    {"id": "shortwave_radiation_sum", "label": "Solar radiation (MJ/m²)"},
]
POWER_VARS = [
    {"id": "PRECTOTCORR", "label": "Precipitation, bias-corrected (mm/day)"},
    {"id": "T2M", "label": "Temperature at 2 m (°C)"},
    {"id": "T2M_MAX", "label": "Maximum temperature (°C)"},
    {"id": "T2M_MIN", "label": "Minimum temperature (°C)"},
    {"id": "RH2M", "label": "Relative humidity at 2 m (%)"},
    {"id": "ALLSKY_SFC_SW_DWN", "label": "All-sky solar radiation (MJ/m²/day)"},
]
_OM_IDS = {v["id"] for v in OPEN_METEO_VARS}
_POWER_IDS = {v["id"] for v in POWER_VARS}
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")
USER_AGENT = "TerraX/2.0 (+https://github.com/khumbemo/terrax)"


def _iso_date(s: Any) -> bool:
    return isinstance(s, str) and bool(_ISO.match(s))


def check_range(lat: float, lon: float, start: str, end: str) -> None:
    if not (abs(lat) <= 90) or not (abs(lon) <= 180):
        raise ValueError("Latitude must be within ±90° and longitude within ±180°.")
    if not _iso_date(start) or not _iso_date(end) or start > end:
        raise ValueError("Choose a start date before the end date (YYYY-MM-DD).")


def _check_vars(vars_: list[str], allowed: set[str]) -> None:
    if not vars_:
        raise ValueError("Choose at least one variable.")
    bad = [v for v in vars_ if v not in allowed]
    if bad:
        raise ValueError(f"Unknown variable: {', '.join(bad)}.")


def open_meteo_url(lat: float, lon: float, start: str, end: str, vars_: list[str]) -> str:
    check_range(lat, lon, start, end)
    _check_vars(vars_, _OM_IDS)
    q = {"latitude": f"{lat:.4f}", "longitude": f"{lon:.4f}", "start_date": start, "end_date": end, "daily": ",".join(vars_), "timezone": "auto"}
    return f"https://archive-api.open-meteo.com/v1/archive?{urlencode(q)}"


def power_url(lat: float, lon: float, start: str, end: str, vars_: list[str]) -> str:
    check_range(lat, lon, start, end)
    _check_vars(vars_, _POWER_IDS)
    q = {
        "parameters": ",".join(vars_),
        "community": "AG",
        "latitude": f"{lat:.4f}",
        "longitude": f"{lon:.4f}",
        "start": start.replace("-", ""),
        "end": end.replace("-", ""),
        "format": "JSON",
    }
    return f"https://power.larc.nasa.gov/api/temporal/daily/point?{urlencode(q)}"


def _csv_cell(v: Any) -> str:
    if v is None or isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        return ""
    return _js_num(v)


def _js_num(v: float) -> str:
    """Number as JavaScript's String() writes it (3 not 3.0)."""
    if float(v).is_integer() and abs(v) < 1e21:
        return str(int(v))
    return repr(float(v))


def _col(vid: str, unit: str | None) -> str:
    return f"{vid} ({unit})" if unit else vid


def _f3(v: Any) -> str:
    return f"{v:.3f}" if isinstance(v, (int, float)) else "undefined"


def open_meteo_to_csv(j: Any) -> tuple[str, str]:
    """Open-Meteo archive JSON → (CSV text with a date column plus one column per variable, note)."""
    if isinstance(j, dict) and j.get("error"):
        raise ValueError(f"Open-Meteo: {j.get('reason') or 'request rejected'}")
    daily = j.get("daily") if isinstance(j, dict) else None
    if not isinstance(daily, dict) or not isinstance(daily.get("time"), list):
        raise ValueError("Open-Meteo returned no daily data.")
    units = j.get("daily_units") or {}
    vars_ = [k for k in daily if k != "time"]
    head = ["date", *[_col(v, units.get(v)) for v in vars_]]
    rows = [",".join([t, *[_csv_cell(daily[v][i] if i < len(daily[v]) else None) for v in vars_]]) for i, t in enumerate(daily["time"])]
    elev = j.get("elevation")
    note = (
        f"Open-Meteo Historical Weather API (ERA5/ERA5-Land reanalysis), grid cell centred near {_f3(j.get('latitude'))}°, "
        f"{_f3(j.get('longitude'))}° (model elevation {_js_num(elev) if isinstance(elev, (int, float)) else '?'} m). "
        "Reanalysis is a gridded model estimate, not a station record; local rainfall in hilly terrain can differ considerably."
    )
    return "\n".join([",".join(head), *rows]), note


def power_to_csv(j: Any) -> tuple[str, str]:
    """NASA POWER daily point JSON → (CSV text, note); the fill value −999 becomes empty."""
    if not isinstance(j, dict):
        raise ValueError("NASA POWER returned no data.")
    if j.get("errors"):
        raise ValueError(f"NASA POWER: {'; '.join(map(str, j['errors']))}")
    p = (j.get("properties") or {}).get("parameter")
    if not p:
        msgs = j.get("messages") or []
        raise ValueError(f"NASA POWER returned no data{': ' + '; '.join(msgs) if msgs else '.'}")
    fill = (j.get("header") or {}).get("fill_value", -999)
    vars_ = list(p)
    dates = sorted({d for v in vars_ for d in p[v]})
    params = j.get("parameters") or {}
    head = ["date", *[_col(v, (params.get(v) or {}).get("units")) for v in vars_]]
    rows = []
    for d in dates:
        iso = f"{d[:4]}-{d[4:6]}-{d[6:8]}"
        cells = []
        for v in vars_:
            x = p[v].get(d)
            cells.append("" if x is None or x == fill else _csv_cell(x))
        rows.append(",".join([iso, *cells]))
    coords = (j.get("geometry") or {}).get("coordinates") or []
    lon = _js_num(coords[0]) if len(coords) > 0 else "?"
    lat = _js_num(coords[1]) if len(coords) > 1 else "?"
    note = (
        f"NASA POWER daily point data (community AG; MERRA-2 meteorology and CERES/GEWEX radiation, about 0.5° × 0.625° grid) "
        f"for {lat}°, {lon}°. Values are grid-cell estimates; −999 fill values were left empty."
    )
    return "\n".join([",".join(head), *rows]), note


def fetch_json(url: str, *, method: str = "GET", body: Any = None, timeout: float = 60.0) -> Any:
    import httpx

    try:
        with httpx.Client(timeout=timeout, headers={"User-Agent": USER_AGENT}, follow_redirects=True) as c:
            r = c.request(method, url, json=body)
    except httpx.HTTPError as err:
        raise ValueError(f"Could not reach {httpx.URL(url).host}: {err}") from err
    try:
        data = r.json()
    except ValueError:
        data = None
    if r.status_code >= 400 and not (isinstance(data, dict) and (data.get("error") or data.get("errors") or data.get("messages"))):
        raise ValueError(f"{httpx.URL(url).host} returned HTTP {r.status_code}.")
    if data is None:
        raise ValueError(f"{httpx.URL(url).host} returned a response that is not JSON.")
    return data


# ── Sentinel-2 via STAC ──────────────────────────────────────────────────────

EARTH_SEARCH = "https://earth-search.aws.element84.com/v1"


@dataclass
class StacItem:
    id: str
    datetime: str
    cloud: float | None
    epsg: int | None
    assets: dict[str, dict[str, Any]] = field(default_factory=dict)
    processing_baseline: str | None = None

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "datetime": self.datetime, "cloud": self.cloud, "epsg": self.epsg, "assets": self.assets, "processingBaseline": self.processing_baseline}

    @classmethod
    def from_public(cls, d: dict[str, Any]) -> StacItem:
        return cls(id=str(d["id"]), datetime=str(d.get("datetime", "")), cloud=d.get("cloud"), epsg=d.get("epsg"), assets=d.get("assets") or {}, processing_baseline=d.get("processingBaseline"))


def stac_search_body(bbox: list[float], start: str, end: str, max_cloud: float, limit: int = 12) -> dict[str, Any]:
    if not _iso_date(start) or not _iso_date(end) or start > end:
        raise ValueError("Choose a start date before the end date.")
    w, s, e, n = (float(v) for v in bbox)
    if not (-180 <= w < e <= 180 and -90 <= s < n <= 90):
        raise ValueError("The search area is not a valid longitude/latitude box.")
    return {
        "collections": ["sentinel-2-l2a"],
        "bbox": [w, s, e, n],
        "datetime": f"{start}T00:00:00Z/{end}T23:59:59Z",
        "query": {"eo:cloud_cover": {"lt": max_cloud}},
        "sortby": [{"field": "properties.datetime", "direction": "desc"}],
        "limit": limit,
    }


def parse_stac_items(fc: Any) -> list[StacItem]:
    if not isinstance(fc, dict) or not isinstance(fc.get("features"), list):
        raise ValueError("The STAC server returned an unexpected response.")
    out = []
    for f in fc["features"]:
        props = f.get("properties") or {}
        code = props.get("proj:epsg")
        if code is None and isinstance(props.get("proj:code"), str):
            try:
                code = int(re.sub(r"^EPSG:", "", props["proj:code"], flags=re.I))
            except ValueError:
                code = None
        assets = {}
        for k, a in (f.get("assets") or {}).items():
            if not isinstance(a, dict) or not a.get("href"):
                continue
            rb = (a.get("raster:bands") or [{}])[0] or {}
            assets[k] = {"href": a["href"], "scale": rb.get("scale"), "offset": rb.get("offset")}
        cloud = props.get("eo:cloud_cover")
        pb = props.get("s2:processing_baseline")
        out.append(
            StacItem(
                id=str(f.get("id")),
                datetime=str(props.get("datetime") or ""),
                cloud=float(cloud) if isinstance(cloud, (int, float)) else None,
                epsg=int(code) if isinstance(code, (int, float)) else None,
                assets=assets,
                processing_baseline=pb if isinstance(pb, str) else None,
            )
        )
    return out


def reflectance_transform(item: StacItem, asset: str) -> tuple[float, float, str]:
    """Scale and offset that turn digital numbers into surface reflectance."""
    a = item.assets.get(asset) or {}
    if a.get("scale") is not None:
        return float(a["scale"]), float(a.get("offset") or 0), "Reflectance = DN × scale + offset from the STAC raster:bands metadata."
    # ESA processing baseline 04.00 (25 Jan 2022) added BOA_ADD_OFFSET = −1000.
    try:
        pb = float(item.processing_baseline) if item.processing_baseline else math.nan
    except ValueError:
        pb = math.nan
    if pb >= 4:
        return 1e-4, -0.1, "Reflectance = (DN − 1000) / 10,000 (processing baseline ≥ 04.00)."
    return 1e-4, 0.0, "Reflectance = DN / 10,000."


S2_BANDS = ["blue", "green", "red", "nir"]
S2_MAX_SIDE = 1500


def _allowed_href(href: str) -> bool:
    # Only public Sentinel-2 COG buckets, so the server cannot be pointed at arbitrary hosts.
    return bool(re.match(r"^https://sentinel-cogs(-[a-z0-9-]+)?\.s3(\.[a-z0-9-]+)?\.amazonaws\.com/", href))


def read_s2_window(item: StacItem, bbox: list[float], out: Path) -> list[str]:
    """Reads B2, B3, B4, B8 (10 m) and SCL (20 m, nearest onto the 10 m grid) for a WGS84 box.

    Writes a 5-band float32 GeoTIFF (reflectance, NaN for no data, SCL codes
    in band 5) to ``out`` and returns notes for the report.
    """
    import rasterio
    from pyproj import Transformer
    from rasterio.enums import Resampling
    from rasterio.windows import Window, from_bounds

    epsg = item.epsg
    if not epsg or not (32601 <= epsg <= 32660 or 32701 <= epsg <= 32760):
        raise ValueError("This scene is not in a WGS84 UTM projection.")
    missing = [k for k in [*S2_BANDS, "scl"] if k not in item.assets]
    if missing:
        raise ValueError(f"The scene lacks assets: {', '.join(missing)}.")
    for k in [*S2_BANDS, "scl"]:
        if not _allowed_href(item.assets[k]["href"]):
            raise ValueError("The scene's files are not on the public Sentinel-2 bucket.")
    w, s, e, n = bbox
    tr = Transformer.from_crs(4326, epsg, always_xy=True)
    xs, ys = tr.transform([w, e, w, e], [s, s, n, n])
    min_e, max_e, min_n, max_n = min(xs), max(xs), min(ys), max(ys)

    env = {"GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR", "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif", "GDAL_HTTP_MAX_RETRY": "3", "GDAL_HTTP_RETRY_DELAY": "1"}
    notes: list[str] = []
    stack: list[np.ndarray] = []
    with rasterio.Env(**env):
        with rasterio.open(item.assets["blue"]["href"]) as ds:
            win = from_bounds(min_e, min_n, max_e, max_n, ds.transform)
            c0, r0 = max(0, math.floor(win.col_off)), max(0, math.floor(win.row_off))
            c1 = min(ds.width, math.ceil(win.col_off + win.width))
            r1 = min(ds.height, math.ceil(win.row_off + win.height))
            if c1 <= c0 or r1 <= r0:
                raise ValueError("The area does not overlap this scene.")
            gw, gh = c1 - c0, r1 - r0
            if max(gw, gh) > S2_MAX_SIDE:
                raise ValueError(f"The area is {gw} × {gh} pixels at 10 m; choose an area under {S2_MAX_SIDE * 10 // 1000} km across.")
            window = Window(c0, r0, gw, gh)
            transform = ds.window_transform(window)
            crs = ds.crs
        for k in S2_BANDS:
            with rasterio.open(item.assets[k]["href"]) as ds:
                dn = ds.read(1, window=window).astype(np.float32)
            scale, offset, note = reflectance_transform(item, k)
            if k == "blue":
                notes.append(note)
            stack.append(np.where(dn == 0, np.nan, dn * np.float32(scale) + np.float32(offset)).astype(np.float32))
        left, top = transform.c, transform.f
        with rasterio.open(item.assets["scl"]["href"]) as ds:
            sw = from_bounds(left, top - gh * 10, left + gw * 10, top, ds.transform)
            scl = ds.read(1, window=sw, out_shape=(gh, gw), resampling=Resampling.nearest, boundless=True, fill_value=0).astype(np.float32)
        stack.append(np.where(scl == 0, np.nan, scl).astype(np.float32))

    profile = {"driver": "GTiff", "width": gw, "height": gh, "count": 5, "dtype": "float32", "crs": crs, "transform": transform, "nodata": np.nan, "compress": "deflate", "tiled": True}
    with rasterio.open(out, "w", **profile) as dst:
        for i, (band, name) in enumerate(zip(stack, ["blue (B2)", "green (B3)", "red (B4)", "nir (B8)", "scl"]), start=1):
            dst.write(band, i)
            dst.set_band_description(i, name)
    cloud = _js_num(item.cloud) if item.cloud is not None else "?"
    notes.append(
        f"Sentinel-2 L2A scene {item.id} ({item.datetime[:10]}, {cloud} % cloud over the tile) from Earth Search; "
        "bands B2, B3, B4, B8 at 10 m and SCL (band 5, resampled from 20 m)."
    )
    return notes
