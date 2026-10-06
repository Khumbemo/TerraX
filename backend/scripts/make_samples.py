"""Generates TerraX's synthetic demo files in backend/data/samples/.

Run: python scripts/make_samples.py

Every file is synthetic (made-up but physically plausible values) so each
TerraX tool can be tried without real data. Do not use them as research data.
The random numbers (mulberry32) and the arithmetic follow the original
JavaScript generator step by step, so the pixel values, coordinate systems and
grids come out identical to the committed files (only the TIFF writer's
metadata differs, because GDAL writes them now).
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from pyproj import Transformer
from rasterio.transform import from_origin

OUT = Path(__file__).resolve().parent.parent / "data" / "samples"


def _i32(x: int) -> int:
    x &= 0xFFFFFFFF
    return x - (1 << 32) if x & 0x80000000 else x


def _imul(a: int, b: int) -> int:
    return _i32((a & 0xFFFFFFFF) * (b & 0xFFFFFFFF))


def rng(seed: int):
    """Deterministic pseudo-random numbers in [0, 1) (mulberry32), as in JavaScript."""
    state = [_i32(seed)]

    def next_() -> float:
        s = _i32(state[0] + 0x6D2B79F5)
        state[0] = s
        t = _imul(s ^ ((s & 0xFFFFFFFF) >> 15), 1 | s)
        t = _i32(_i32(t + _imul(t ^ ((t & 0xFFFFFFFF) >> 7), 61 | t)) ^ t)
        return ((t ^ ((t & 0xFFFFFFFF) >> 14)) & 0xFFFFFFFF) / 4294967296

    return next_


def noise_field(w: int, h: int, cell: float, seed: int) -> np.ndarray:
    """Smooth value noise (float32, shape h × w) for natural-looking fields."""
    r = rng(seed)
    gw, gh = math.ceil(w / cell) + 2, math.ceil(h / cell) + 2
    g = np.array([r() for _ in range(gw * gh)])
    gx = np.arange(w) / cell
    gy = np.arange(h) / cell
    x0, y0 = np.floor(gx).astype(int), np.floor(gy).astype(int)
    s = lambda t: t * t * (3 - 2 * t)
    fx, fy = s(gx - x0)[None, :], s(gy - y0)[:, None]
    X0, Y0 = x0[None, :], y0[:, None]
    v00, v10 = g[Y0 * gw + X0], g[Y0 * gw + X0 + 1]
    v01, v11 = g[(Y0 + 1) * gw + X0], g[(Y0 + 1) * gw + X0 + 1]
    return (v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy).astype(np.float32)


# UTM zone 46N (EPSG:32646), south-west of Kohima; 30 m pixels.
W, H, RES, E0, N0 = 240, 200, 30, 603000, 2846000


def write_tif(name: str, bands: list[np.ndarray], res: float = RES, e0: float = E0, n0: float = N0, dtype: str = "float32", nodata: float | None = -9999) -> None:
    h, w = bands[0].shape
    profile = {"driver": "GTiff", "width": w, "height": h, "count": len(bands), "dtype": dtype, "crs": "EPSG:32646", "transform": from_origin(e0, n0, res, res)}
    if nodata is not None:
        profile["nodata"] = nodata
    if dtype == "uint8" and len(bands) == 3:
        profile["photometric"] = "RGB"
    with rasterio.open(OUT / name, "w", **profile) as d:
        for i, b in enumerate(bands, 1):
            d.write(b.astype(dtype), i)
    print("wrote", name)


def js_round(x: float) -> float:
    """JavaScript Math.round: halves go up."""
    return math.floor(x + 0.5)


def js_str(v) -> str:
    """A value as JavaScript's String() writes it."""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    yy, xx = np.mgrid[0:H, 0:W].astype(float)

    # ── Terrain: ridge-and-valley DEM, 1100–2100 m ──
    n1, n2 = noise_field(W, H, 40, 7).astype(float), noise_field(W, H, 12, 8).astype(float)
    ridge = np.exp(-(((xx - 150) / 55) ** 2)) * 650
    valley = -np.exp(-(((xx - 60 - yy * 0.2) / 18) ** 2)) * 180
    write_tif("terrain_dem_synthetic.tif", [1250 + ridge + valley + n1 * 250 + n2 * 40])

    # ── Forest: NDVI before (2016) and after (2024) with clearings and regrowth ──
    canopy, fine = noise_field(W, H, 25, 11).astype(float), noise_field(W, H, 6, 12).astype(float)
    r = rng(99)
    clearings = []
    for _ in range(7):
        clearings.append({"x": 30 + r() * 180, "y": 20 + r() * 160, "rx": 6 + r() * 14, "ry": 5 + r() * 10})
    river = np.abs(xx - 60 - yy * 0.2) < 3
    farm = (xx > 190) & (yy > 130)
    before = np.where(river, -0.1, np.where(farm, 0.3 + fine * 0.1, 0.62 + canopy * 0.2 + fine * 0.05))
    cleared = np.zeros_like(river)
    for c in clearings:
        cleared |= ((xx - c["x"]) / c["rx"]) ** 2 + ((yy - c["y"]) / c["ry"]) ** 2 < 1
    after = np.where(cleared & ~river & ~farm, 0.18 + fine * 0.15, np.where(farm & (xx > 215), 0.62 + fine * 0.08, before + (fine - 0.5) * 0.04))
    write_tif("forest_ndvi_2016_synthetic.tif", [before])
    write_tif("forest_ndvi_2024_synthetic.tif", [after])

    # ── Burn: pre- and post-fire NBR with a graded fire scar and some regrowth ──
    nb = noise_field(W, H, 9, 21).astype(float)
    base = np.where(river, -0.2, 0.3 + canopy * 0.3)
    d = np.sqrt(((xx - 150) / 60) ** 2 + ((yy - 90) / 42) ** 2)
    dnbr = (nb - 0.5) * 0.06  # background noise
    dnbr = np.where(~river & (d < 1), 0.08 + 0.72 * np.clip(1 - d, 0, None) ** 0.8 + (nb - 0.5) * 0.1, dnbr)
    dnbr = np.where(~river & (xx < 45) & (yy > 150), -0.18 + (nb - 0.5) * 0.05, dnbr)  # regrowth on an old clearing
    write_tif("burn_nbr_pre_synthetic.tif", [base])
    write_tif("burn_nbr_post_synthetic.tif", [np.clip(base - dnbr, -1, 1)])

    # ── Series: six dated NDVI images (same March season) with slow canopy loss ──
    sw, sh = 60, 50
    sn = noise_field(sw, sh, 8, 31).astype(float).ravel()
    dates = ["2019-03-10", "2020-03-14", "2021-03-09", "2022-03-12", "2023-03-15", "2024-03-11"]
    for t, day in enumerate(dates):
        rr = rng(40 + t)
        band = np.empty(sw * sh)
        for k in range(band.size):
            x = k % sw
            # A clearing front advances from the east edge ~4 px per year.
            band[k] = (0.25 if x > sw - 4 - 4 * t else 0.72) + (sn[k] - 0.5) * 0.12 + (rr() - 0.5) * 0.04
        write_tif(f"series_ndvi_{day}_synthetic.tif", [band.reshape(sh, sw)])

    # ── Satellite: 4-band surface reflectance ×10,000 (B2 blue, B3 green, B4 red, B8 NIR) ──
    riv4 = np.abs(xx - 60 - yy * 0.2) < 4
    town = (xx - 200) ** 2 + (yy - 40) ** 2 < 22**2
    f = canopy
    pick = lambda rv, tw, fo: np.where(riv4, rv, np.where(town, tw, fo))
    write_tif("satellite_4band_synthetic.tif", [
        pick(700, 1300 + fine * 300, 300 + (1 - f) * 250),
        pick(900, 1400 + fine * 300, 550 + (1 - f) * 250),
        pick(600, 1500 + fine * 300, 350 + (1 - f) * 500),
        pick(350, 2100 + fine * 300, 2800 + f * 1500),
    ])

    # ── Survey: a fictional plot boundary around the largest clearing, inside the forest rasters ──
    plot = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"name": "Sample plot A (fictional)"}, "geometry": {"type": "Polygon", "coordinates": [
        [[94.05731, 25.68768], [94.05167, 25.68095], [94.04299, 25.68286], [94.04373, 25.69222], [94.05166, 25.6941], [94.05731, 25.68768]]]}}]}
    (OUT / "survey_plot_synthetic.geojson").write_text(json.dumps(plot, indent=2), encoding="utf-8")
    print("wrote survey_plot_synthetic.geojson")

    # ── Climate: 35 years of monthly rainfall and temperature (1990–2024) ──
    r = rng(1990)
    rain_mean = [15, 30, 70, 150, 250, 380, 420, 350, 260, 130, 30, 12]  # loosely north-east India (mm/month)
    t_mean = [13.5, 15.5, 19, 21.5, 23, 24.5, 25, 25, 24, 21.5, 18, 14.5]
    rows = ["date,precipitation_mm,temperature_c"]
    for y in range(1990, 2025):
        monsoon = 0.6 if y in (2002, 2005, 2009, 2014, 2023) else 1  # weak monsoons, independent of the warming trend
        for m in range(12):
            mean = rain_mean[m] * (monsoon if 5 <= m <= 8 else 1)
            rain = -(mean / 2) * (math.log(1 - r()) + math.log(1 - r()))  # gamma(shape 2): two exponentials
            temp = t_mean[m] + 0.025 * (y - 1990) + (r() - 0.5) * 1.6
            rows.append(f"{y}-{m + 1:02d}-15,{rain:.1f},{temp:.2f}")
    (OUT / "monthly_climate_1990_2024_synthetic.csv").write_text("\n".join(rows) + "\n", encoding="utf-8")
    print("wrote monthly_climate_1990_2024_synthetic.csv")

    residential()
    photo()
    inventory()


def _pip(poly, x, y) -> np.ndarray:
    inside = np.zeros(np.broadcast(x, y).shape, bool)
    j = len(poly) - 1
    for i in range(len(poly)):
        (xi, yi), (xj, yj) = poly[i], poly[j]
        with np.errstate(divide="ignore", invalid="ignore"):
            cross = ((yi > y) != (yj > y)) & (x < (xj - xi) * (y - yi) / (yj - yi) + xi)
        inside ^= cross
        j = i
    return inside


def _seg_dist(x, y, a, b) -> np.ndarray:
    (ax, ay), (bx, by) = a, b
    t = np.clip(((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2), 0, 1)
    return np.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay))


def residential() -> None:
    """Three dated 0.5 m RGB images (2019, 2021, 2024) of a fictional plot, and its boundary."""
    re_, rn, res, sz = 608000, 2842500, 0.5, 200  # 100 m × 100 m, UTM 46N
    plot = [[re_ + 30, rn - 30], [re_ + 62, rn - 26], [re_ + 58, rn - 66], [re_ + 26, rn - 70]]
    house = [[re_ + 34, rn - 36], [re_ + 48, rn - 34], [re_ + 46, rn - 50], [re_ + 32, rn - 52]]
    neighbour = [[re_ + 70, rn - 34], [re_ + 86, rn - 32], [re_ + 84, rn - 50], [re_ + 68, rn - 52]]
    trees = [[re_ + 40, rn - 60, 3], [re_ + 52, rn - 58, 2.5], [re_ + 15, rn - 20, 4], [re_ + 90, rn - 75, 5], [re_ + 20, rn - 85, 3.5]]

    def east(t):
        return [plot[1][0] + (plot[2][0] - plot[1][0]) * t, plot[1][1] + (plot[2][1] - plot[1][1]) * t]

    def extension(depth):
        # Neighbour's shed reaching `depth` m across the east boundary, 45–70 % down the edge.
        a, b = east(0.45), east(0.7)
        return [[re_ + 70, a[1] + 0.4], [a[0] - depth, a[1] - 0.4], [b[0] - depth, b[1] - 0.4], [re_ + 70, b[1] + 0.4]]

    carport = [[re_ + 36, rn - 54], [re_ + 44, rn - 53], [re_ + 43.5, rn - 60], [re_ + 35.5, rn - 61]]
    scenes = [
        {"date": "2019-02-10", "ext": 0, "carport": False, "gain": 1, "tint": [0, 0, 0], "shift": 0, "seed": 71},
        {"date": "2021-02-14", "ext": 2.5, "carport": False, "gain": 1.04, "tint": [4, 2, -3], "shift": 0, "seed": 72},
        {"date": "2024-02-08", "ext": 5, "carport": True, "gain": 1.12, "tint": [8, 4, -6], "shift": 0.5, "seed": 73},
    ]
    tex = noise_field(sz, sz, 6, 80).astype(float)  # same ground texture every year
    rows, cols = np.mgrid[0:sz, 0:sz].astype(float)
    for sc in scenes:
        r = rng(sc["seed"])
        e = re_ + (cols + 0.5) * res - sc["shift"]  # the shift mimics misregistration
        n = rn - (rows + 0.5) * res
        t = tex
        c = np.stack([86 + 30 * t, 118 + 30 * t, 62 + 20 * t], -1)  # grass

        c[n < rn - 92] = [96, 94, 92]  # road along the south
        m = _pip(plot, e, n)
        c[m] = np.stack([96 + 24 * t, 132 + 26 * t, 70 + 18 * t], -1)[m]  # owner's lawn
        c[_pip(house, e, n)] = [148, 70, 60]  # red roof
        c[_pip(neighbour, e, n)] = [120, 128, 140]  # grey roof
        for te, tn, rad in trees:
            m = np.hypot(e - te, n - tn) < rad
            c[m] = np.stack([40 + 20 * t, 72 + 20 * t, 38 + 10 * t], -1)[m]
        if sc["ext"]:
            c[_pip(extension(sc["ext"]), e, n)] = [176, 172, 166]  # new concrete/tin roof
        if sc["carport"]:
            c[_pip(carport, e, n)] = [70, 90, 120]  # owner's blue carport
        for i in range(4):
            c[_seg_dist(e, n, plot[i], plot[(i + 1) % 4]) < 0.3] = [120, 96, 70]  # fence along the boundary
        noise = np.array([[[r() for _ in range(3)] for _ in range(sz)] for _ in range(sz)])  # row, col, band order as in JS
        out = np.clip(np.floor(c * sc["gain"] + np.array(sc["tint"]) + (noise - 0.5) * 10 + 0.5), 0, 255).astype(np.uint8)
        write_tif(f"plot_{sc['date']}_synthetic.tif", [out[..., b] for b in range(3)], res=res, e0=re_, n0=rn, dtype="uint8", nodata=None)
    inv = Transformer.from_crs(32646, 4326, always_xy=True)
    ring = [[round(v, 7) for v in inv.transform(x, y)] for x, y in [*plot, plot[0]]]
    fc = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"name": "Sample residential plot (fictional)"}, "geometry": {"type": "Polygon", "coordinates": [ring]}}]}
    (OUT / "plot_boundary_synthetic.geojson").write_text(json.dumps(fc, indent=2), encoding="utf-8")
    print("wrote plot_boundary_synthetic.geojson")


def photo() -> None:
    """A synthetic aerial RGB image (PNG) with forest, fields and a river."""
    pw, ph = 480, 320
    pn, pf = noise_field(pw, ph, 30, 21).astype(float), noise_field(pw, ph, 5, 22).astype(float)
    y, x = np.mgrid[0:ph, 0:pw].astype(float)
    river = np.abs(x - 140 - np.sin(y / 40) * 30) < 9
    field = (x > 300) & (((np.floor(x / 45) + np.floor(y / 50)) % 2) == 0)
    img = np.where(river[..., None], np.array([60, 90, 110], float),
                   np.where(field[..., None], np.stack([150 + pf * 30, 125 + pf * 25, 85 + pf * 20], -1),
                            np.stack([40 + pn * 40 + pf * 15, 85 + pn * 60 + pf * 20, 40 + pn * 25], -1)))
    Image.fromarray(np.clip(np.floor(img + 0.5), 0, 255).astype(np.uint8), "RGB").save(OUT / "aerial_photo_synthetic.png", optimize=True)
    print("wrote aerial_photo_synthetic.png")


def inventory() -> None:
    """Synthetic tree inventory in the Forest-Capture survey CSV layout (fictional plots and measurements)."""
    r = rng(2024)
    species = ["Schima wallichii", "Castanopsis indica", "Quercus serrata", "Alnus nepalensis", "Macaranga denticulata", "Engelhardia spicata"]
    header = ["Survey", "Date", "Location", "Investigator", "Q#", "Size", "MeasDate", "Observer", "Species", "Stage", "Status", "Phenology", "Abundance", "Stems", "DBH", "DBH_MeasHt",
              "GBH", "Height", "CrownClass", "CrownDiam", "Distance", "Azimuth", "Health", "Bark", "DecayClass", "GPS", "Cover%", "Stratum"]
    rows: list[list] = [header]
    head = ["Demo survey (synthetic)", "2025-03-14", "Fictional hill forest", "TerraX sample"]
    for q in range(1, 6):
        n = 9 + math.floor(r() * 8)
        for i in range(n):
            sp = species[math.floor(r() * len(species))]
            # Right-skewed diameters, 6–75 cm; height from a saturating H–D curve with noise.
            dbh = js_round((6 + 69 * r() ** 2.2) * 10) / 10
            height = js_round((1.3 + 32 * (1 - math.exp(-0.035 * dbh))) * (0.85 + 0.3 * r()) * 10) / 10
            status = "dead-standing" if r() < 0.06 else "live"
            use_gbh = r() < 0.2
            rows.append([*head, q, 400, "2025-03-14", "", sp, "tree", status, "", 1, 1, 0 if use_gbh else dbh, 1.3,
                         js_round(dbh * math.pi * 10) / 10 if use_gbh else 0, 0 if i % 7 == 3 else height, "", 0, 0, 0, "", "", 0, "", 0, ""])
        rows.append([*head, q, 400, "2025-03-14", "", "Seedlings (mixed)", "seedling", "live", "", 12, 1, 0, 1.3, 0, 0.4, "", 0, 0, 0, "", "", 0, "", 0, ""])
    rows += [[], ["--- TRANSECT DATA ---"],
             ["Survey", "T#", "Method", "Length", "Width", "Bearing", "Slope", "MeasDate", "Observer", "Species", "LifeForm", "IntType", "StartDist", "EndDist", "Distance", "Cover%", "Height", "DBH", "Abundance"],
             ["Demo survey (synthetic)", 1, "line", 50, 2, 90, 5, "2025-03-14", "", "Imperata cylindrica", "grass", "", 0, 3, 3, 40, 0.8, 0, 1]]
    csv = "\n".join(",".join('"' + js_str(c).replace('"', '""') + '"' for c in row) for row in rows)
    (OUT / "forest_capture_inventory_synthetic.csv").write_text("﻿" + csv, encoding="utf-8")
    print("wrote forest_capture_inventory_synthetic.csv", len(rows), "rows")


if __name__ == "__main__":
    main()
