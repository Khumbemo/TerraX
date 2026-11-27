"""Renders TerraX's space backgrounds (public/backgrounds/*.webp and their thumbnails).

These are artistic renderings made from noise, simple optics and sphere geometry: not photographs, and not maps or
data. Planet layouts (bands, ring divisions, lunar maria) only follow the real objects loosely so that each one is
recognisable. They are made by this script and are released with TerraX under its MIT licence.

Run (needs numpy, scipy and Pillow with WebP):  python scripts/render-backgrounds.py [name ...]
"""

from __future__ import annotations

import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray
from PIL import Image
from scipy import ndimage

W, H = 2560, 1440
OUT = Path(__file__).resolve().parent.parent / "public" / "backgrounds"
#: Image and field arrays (float32 mostly; numpy promotes some intermediate results to float64).
Arr = NDArray[Any]


# ---------------------------------------------------------------------------------------------------------------------
# Building blocks


def fbm(h: int, w: int, seed: int, base: int = 4, octaves: int = 7, falloff: float = 0.55) -> Arr:
    """Fractal noise in about [-1, 1]: smooth random grids, doubling in detail and shrinking in strength."""
    rng = np.random.default_rng(seed)
    out = np.zeros((h, w), np.float32)
    amp, total = 1.0, 0.0
    for o in range(octaves):
        cells = base * 2**o
        gh, gw = max(2, int(cells * h / max(h, w)) + 2), max(2, int(cells * w / max(h, w)) + 2)
        grid = rng.standard_normal((gh, gw)).astype(np.float32)
        up = ndimage.zoom(grid, (h / (gh - 1), w / (gw - 1)), order=3, mode="reflect")[:h, :w]
        out += amp * up
        total += amp
        amp *= falloff
    out /= total
    return np.asarray(np.clip(out / (3 * out.std() + 1e-6), -1, 1), np.float32)


def streaks(h: int, w: int, seed: int, stretch: int = 6, base: int = 6, octaves: int = 7) -> Arr:
    """Fractal noise stretched sideways, like wind-sheared cloud bands."""
    small = fbm(h, max(8, w // stretch), seed, base=base, octaves=octaves)
    return np.asarray(ndimage.zoom(small, (1, w / small.shape[1]), order=1)[:, :w], np.float32)


def ridged(h: int, w: int, seed: int, base: int = 4, octaves: int = 8) -> Arr:
    """Thin bright filaments where the noise crosses zero."""
    return (1 - np.abs(fbm(h, w, seed, base=base, octaves=octaves))) ** 6


def warp(field: Arr, dx: Arr, dy: Arr) -> Arr:
    """Samples a field at displaced coordinates (domain warping gives gas and cloud shapes)."""
    h, w = field.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    return np.asarray(ndimage.map_coordinates(field, [yy + dy, xx + dx], order=1, mode="reflect"), np.float32)


def star_colour(n: int, rng: np.random.Generator) -> Arr:
    """Star tints from blue-white to orange, weighted toward white and yellow like a real field."""
    palette = np.array([[0.70, 0.80, 1.00], [0.85, 0.90, 1.00], [1.00, 1.00, 1.00], [1.00, 0.95, 0.85], [1.00, 0.85, 0.65], [1.00, 0.72, 0.50]], np.float32)
    idx = rng.choice(len(palette), n, p=[0.10, 0.20, 0.30, 0.22, 0.12, 0.06])
    return palette[idx]


def add_stars(img: Arr, n: int, seed: int, density: Arr | None = None, bright: float = 1.0, spikes: bool = False) -> None:
    """Adds n stars, optionally placed by a density map. Most are faint points; a few bright ones get a glow."""
    rng = np.random.default_rng(seed)
    h, w = img.shape[:2]
    if density is None:
        ys, xs = rng.uniform(0, h, n), rng.uniform(0, w, n)
    else:
        p = density.ravel().astype(np.float64)
        p /= p.sum()
        k = rng.choice(p.size, n, p=p)
        ys, xs = k // w + rng.uniform(0, 1, n), k % w + rng.uniform(0, 1, n)
    flux = (rng.pareto(1.6, n) + 1) * 0.06 * bright  # many faint stars, few bright ones
    cols = star_colour(n, rng)
    acc = np.zeros_like(img)
    iy, ix = ys.astype(int).clip(0, h - 1), xs.astype(int).clip(0, w - 1)
    np.add.at(acc, (iy, ix), cols * np.minimum(flux, 1.5)[:, None])
    img += ndimage.gaussian_filter(acc, (0.6, 0.6, 0)) * 3.0
    # Glows around the brightest few.
    for i in np.argsort(flux)[-max(3, n // 1500) :]:
        r = int(8 + 10 * min(flux[i], 3))
        y0, y1, x0, x1 = max(0, iy[i] - r), min(h, iy[i] + r + 1), max(0, ix[i] - r), min(w, ix[i] + r + 1)
        yy, xx = np.mgrid[y0:y1, x0:x1]
        d2 = ((yy - ys[i]) ** 2 + (xx - xs[i]) ** 2).astype(np.float32)
        s = 0.8 + 0.5 * min(flux[i], 3)
        g = np.exp(-d2 / (2 * s * s)) + 0.025 * np.exp(-d2 / (2 * (5 * s) ** 2))
        if spikes:
            g += 0.35 * (np.exp(-np.abs(yy - ys[i]) / 0.8) + np.exp(-np.abs(xx - xs[i]) / 0.8)) * np.exp(-np.sqrt(d2) / (r * 0.45))
        img[y0:y1, x0:x1] += g[..., None] * cols[i] * min(flux[i], 3) * 1.6


def tonemap(img: Arr, exposure: float = 1.0) -> Arr:
    """Soft highlight roll-off, then sRGB gamma."""
    x = 1 - np.exp(-np.maximum(img, 0) * exposure)
    return np.asarray(np.power(x, 1 / 2.2), np.float32)


def save(name: str, img: Arr, exposure: float = 1.0) -> None:
    rgb = tonemap(img, exposure)
    rng = np.random.default_rng(7)
    rgb = rgb + rng.uniform(-0.5, 0.5, rgb.shape).astype(np.float32) / 255  # dither: no banding in dark gradients
    im = Image.fromarray((np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB")
    OUT.mkdir(parents=True, exist_ok=True)
    im.save(OUT / f"{name}.webp", "WEBP", quality=82, method=6)
    im.resize((384, 216), Image.Resampling.LANCZOS).save(OUT / f"{name}.thumb.webp", "WEBP", quality=80, method=6)
    print(f"{name}: {(OUT / f'{name}.webp').stat().st_size // 1024} KB")


def sky(seed: int, tint: tuple[float, float, float] = (0.0022, 0.0028, 0.0055)) -> Arr:
    """Near-black sky with a faint uneven glow."""
    n = (fbm(H, W, seed, base=3, octaves=5) + 1) / 2
    return (np.ones((H, W, 3), np.float32) * np.array(tint, np.float32)) * (0.6 + 0.8 * n[..., None])


def sphere(cx: float, cy: float, r: float) -> tuple[NDArray[np.bool_], Arr, Arr, Arr]:
    """Pixels on a disc and their unit normals (x right, y up, z toward the viewer)."""
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    x, y = (xx - cx) / r, (cy - yy) / r
    rr = x * x + y * y
    on = rr <= 1
    z = np.sqrt(np.clip(1 - rr, 0, 1))
    return on, x, y, z


def rotate_normals(x: Arr, y: Arr, z: Arr, tilt_deg: float) -> tuple[Arr, Arr, Arr]:
    """Tilts the body toward the viewer by tilt_deg (positive shows more of the north)."""
    t = np.radians(tilt_deg)
    return x, y * np.cos(t) + z * np.sin(t), -y * np.sin(t) + z * np.cos(t)


def unit(v: tuple[float, float, float]) -> NDArray[np.float32]:
    a = np.array(v, np.float32)
    return a / np.linalg.norm(a)


def edge(on: NDArray[np.bool_], x: Arr, y: Arr) -> Arr:
    """Anti-aliased disc coverage (about one pixel of soft edge)."""
    rr = np.sqrt(x * x + y * y)
    r_px = 1 / max(np.abs(np.diff(x[0, :2]))[0], 1e-6)
    return np.asarray(np.clip((1 - rr) * r_px + 0.5, 0, 1), np.float32)


def atmosphere(img: Arr, x: Arr, y: Arr, light: NDArray[np.float32], colour: tuple[float, float, float], width: float, strength: float) -> None:
    """A thin glowing rim just outside the limb, on the lit side."""
    rr = np.sqrt(x * x + y * y)
    outside = np.clip(rr - 1, 0, None)
    glow = np.exp(-outside / width) * (rr > 1.0)
    nx, ny = x / np.maximum(rr, 1e-6), y / np.maximum(rr, 1e-6)
    lit = np.clip(nx * light[0] + ny * light[1] + 0.35, 0, 1)
    img += (glow * lit * strength)[..., None] * np.array(colour, np.float32)


# ---------------------------------------------------------------------------------------------------------------------
# Scenes


def starfield() -> Arr:
    img = sky(11)
    neb = np.clip(fbm(H, W, 12, base=2, octaves=6), 0, 1) ** 2
    img += neb[..., None] * np.array([0.020, 0.012, 0.045], np.float32)
    add_stars(img, 14000, 13, bright=0.9)
    return np.asarray(img, np.float32)


def milky_way() -> Arr:
    img = sky(21)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    # A band from lower left to upper right, brightest toward the galactic centre (right of middle).
    a = np.radians(-24)
    u = (xx - W / 2) * np.cos(a) - (yy - H / 2) * np.sin(a)
    v = (xx - W / 2) * np.sin(a) + (yy - H / 2) * np.cos(a)
    n1, n2 = fbm(H, W, 22, base=6), fbm(H, W, 23, base=12, octaves=6)
    v2 = v + 60 * n1
    core = np.exp(-((u - 380) ** 2) / (2 * 700**2))
    band = np.exp(-(v2**2) / (2 * (190 + 90 * core) ** 2)) * (0.45 + 0.55 * core)
    glow = band * (0.75 + 0.5 * n2)
    # Dust lanes: dark filaments along the middle of the band.
    lane = np.clip(fbm(H, W, 24, base=10, octaves=7), 0, 1)
    rift = np.exp(-((v2 + 25 * n2) ** 2) / (2 * 55**2)) * np.clip(0.4 + core, 0, 1)
    dust = np.clip(1 - 1.5 * lane * band - 0.75 * rift * (0.6 + 0.4 * lane), 0.05, 1)
    warm, cool = np.array([1.0, 0.80, 0.58], np.float32), np.array([0.62, 0.72, 1.0], np.float32)
    col = warm * core[..., None] + cool * (1 - core[..., None])
    img += (glow * dust)[..., None] * col * 0.55
    # Pink emission knots along the band.
    knots = np.clip(fbm(H, W, 25, base=60, octaves=3), 0.6, 1) - 0.6
    img += (knots * band * core * dust * 0.9)[..., None] * np.array([1.0, 0.35, 0.45], np.float32)
    add_stars(img, 26000, 26, density=(0.15 + band * dust).astype(np.float32), bright=0.75)
    add_stars(img, 2500, 27, bright=1.2)
    return np.asarray(img, np.float32)


def nebula() -> Arr:
    img = sky(31)
    wx, wy = fbm(H, W, 32, base=2, octaves=5) * 220, fbm(H, W, 33, base=2, octaves=5) * 220
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    focus = np.exp(-(((xx - W * 0.60) / (W * 0.40)) ** 2 + ((yy - H * 0.50) / (H * 0.62)) ** 2))

    def gas(seed: int, base: int, gain: float, dx: Arr, dy: Arr) -> Arr:
        cloud = 1 / (1 + np.exp(-(warp(fbm(H, W, seed, base=base, octaves=8, falloff=0.6), dx, dy) - 0.05) * 4))
        fil = warp(ridged(H, W, seed + 100, base=base), dx, dy)
        return np.asarray(ndimage.gaussian_filter((cloud * 0.6 + fil * 0.9) * focus * gain, 1.2), np.float32)

    h_alpha = gas(34, 3, 1.0, wx, wy)  # hydrogen-alpha: red
    o_iii = gas(35, 4, 0.9, wy, wx) * focus  # oxygen III: teal, toward the hot centre
    s_ii = gas(36, 5, 0.5, -wx, wy)  # sulphur II: gold
    dust = ndimage.gaussian_filter(np.clip(warp(fbm(H, W, 37, base=5, octaves=8), wx * 0.6, wy * 0.6), 0, 1), 1.5)
    shade = np.clip(1 - 1.8 * dust**1.4, 0.04, 1)
    img += (h_alpha * shade)[..., None] * np.array([1.0, 0.16, 0.28], np.float32) * 0.5
    img += (o_iii * shade)[..., None] * np.array([0.10, 0.70, 0.80], np.float32) * 0.55
    img += (s_ii * shade)[..., None] * np.array([1.0, 0.66, 0.28], np.float32) * 0.3
    cl = np.exp(-(((xx - W * 0.6) ** 2 + (yy - H * 0.47) ** 2) / (2 * 120**2)))
    img += (cl * shade)[..., None] * np.array([0.55, 0.65, 0.9], np.float32) * 0.35
    add_stars(img, 12000, 38, bright=0.8)
    add_stars(img, 220, 39, density=(cl + 0.01).astype(np.float32), bright=2.0, spikes=True)
    return np.asarray(img, np.float32)


def spiral_galaxy() -> Arr:
    img = sky(41)
    cx, cy, scale = W * 0.58, H * 0.52, 430.0
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    # Galaxy plane seen at 52° and turned 28° on the sky.
    pa, inc = np.radians(28), np.radians(52)
    u = ((xx - cx) * np.cos(pa) + (yy - cy) * np.sin(pa)) / scale
    v = (-(xx - cx) * np.sin(pa) + (yy - cy) * np.cos(pa)) / scale / np.cos(inc)
    r = np.sqrt(u * u + v * v) + 1e-6
    th = np.arctan2(v, u)
    n = fbm(H, W, 42, base=14, octaves=6)
    pitch = np.radians(16)
    arms = np.zeros_like(r)
    for k in range(2):  # two logarithmic arms
        phase = th - np.log(r) / np.tan(pitch) + k * np.pi
        arms += np.cos(phase / 1 + 0.0) ** 2
    arms = (arms / 2) ** 2 * (0.7 + 0.5 * np.clip(fbm(H, W, 46, base=30, octaves=4), -1, 1))
    disc = np.exp(-r / 0.55)
    bulge = np.exp(-((r / 0.16) ** 1.2))
    lumps = np.clip(0.6 + 0.6 * n, 0, 1.4)
    blue = arms * disc * lumps * (r > 0.12)
    img += (disc * 0.25)[..., None] * np.array([0.85, 0.82, 0.80], np.float32)
    img += (blue * 1.2)[..., None] * np.array([0.55, 0.70, 1.0], np.float32)
    img += (bulge * 2.2)[..., None] * np.array([1.0, 0.85, 0.62], np.float32)
    # Dust lanes on the inner edge of each arm, and pink star-forming regions on the arms.
    lanes = np.zeros_like(r)
    for k in range(2):
        phase = th - np.log(r) / np.tan(pitch) + k * np.pi - 0.55
        lanes += np.cos(phase) ** 8
    dust = np.clip(1 - 0.75 * lanes * disc * 2.2 * (0.6 + 0.5 * n) * (r > 0.1), 0.15, 1)
    img *= dust[..., None]
    hii = np.clip(fbm(H, W, 43, base=40, octaves=3), 0.62, 1) - 0.62
    img += (hii * blue * 9)[..., None] * np.array([1.0, 0.35, 0.55], np.float32)
    add_stars(img, 2500, 44, density=(blue + 0.02).astype(np.float32), bright=0.5)
    add_stars(img, 9000, 45, bright=0.8)
    return np.asarray(img, np.float32)


def deep_field() -> Arr:
    img = sky(51, (0.0015, 0.0018, 0.0035))
    rng = np.random.default_rng(52)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    acc = np.zeros_like(img)
    for _ in range(1400):  # distant galaxies: small, many colours and shapes
        x0, y0 = rng.uniform(0, W), rng.uniform(0, H)
        size = float(np.clip(rng.pareto(2.2) * 3 + 1.2, 1.2, 34))
        q, pa = rng.uniform(0.25, 1), rng.uniform(0, np.pi)
        r = int(size * 4) + 2
        ys, xs = slice(max(0, int(y0) - r), min(H, int(y0) + r)), slice(max(0, int(x0) - r), min(W, int(x0) + r))
        dx, dy = xx[ys, xs] - x0, yy[ys, xs] - y0
        a = (dx * np.cos(pa) + dy * np.sin(pa)) / size
        b = (-dx * np.sin(pa) + dy * np.cos(pa)) / (size * q)
        rr = np.sqrt(a * a + b * b)
        prof = np.exp(-rr * 1.8)
        if size > 9 and rng.uniform() < 0.6:  # some show spiral structure
            th = np.arctan2(b, a)
            prof *= 0.55 + 0.45 * np.cos(2 * th - 3.2 * np.log(rr + 0.2)) ** 2
        red = min(1.0, size / 14)
        col = np.array([1.0, 0.75 + 0.15 * rng.uniform(), 0.55], np.float32) * red + np.array([0.6, 0.72, 1.0], np.float32) * (1 - red)
        if rng.uniform() < 0.25:
            col = np.array([1.0, 0.55, 0.35], np.float32)  # very distant, reddened
        acc[ys, xs] += prof[..., None] * col * rng.uniform(0.15, 0.7)
    img += acc
    add_stars(img, 700, 53, bright=0.6)
    add_stars(img, 22, 54, bright=3.0, spikes=True)
    return np.asarray(img, np.float32)


def moon() -> Arr:
    """The near side at a waxing gibbous phase. Maria and a few large craters sit roughly where the real ones are."""
    img = sky(61, (0.0015, 0.0018, 0.0035))
    add_stars(img, 2500, 62, bright=0.5)
    cx, cy, R = W * 0.70, H * 0.52, H * 0.44
    on, x, y, z = sphere(cx, cy, R)
    lat, lon = np.arcsin(np.clip(y, -1, 1)), np.arctan2(x, z)
    albedo = 0.62 + 0.10 * fbm(H, W, 63, base=10, octaves=7)
    # Maria: (latitude, longitude, radius) in degrees, approximate.
    maria: list[tuple[float, float, float]] = [(18, -57, 30), (33, -16, 17), (28, 17, 11), (8, 31, 13), (17, 59, 8), (-8, 51, 9), (-15, 35, 8), (-21, -17, 12), (-24, -39, 7), (55, 0, 7),
             (13, 4, 6), (-10, -23, 8), (0, -40, 14), (48, -35, 10)]
    dark = np.zeros_like(x)
    ragged = fbm(H, W, 67, base=12, octaves=6)  # irregular shorelines
    for la, lo, rad in maria:
        d = np.degrees(np.arccos(np.clip(np.sin(lat) * np.sin(np.radians(la)) + np.cos(lat) * np.cos(np.radians(la)) * np.cos(lon - np.radians(lo)), -1, 1)))
        dark = 1 - (1 - dark) * (1 - np.clip((1.15 - d / rad + 0.4 * ragged) * 1.6, 0, 1))  # soft union
    mare_edge = fbm(H, W, 64, base=18, octaves=5) * 0.25
    albedo = albedo - 0.36 * np.clip(dark + mare_edge * (dark > 0.05), 0, 1)
    # Craters: a height field (bowl and rim) gives shading; a few bright young ones have rays.
    height = np.zeros_like(x)
    rng = np.random.default_rng(65)
    craters: list[tuple[float, float, float, bool]] = [(-43, -11, 2.6, True), (10, -20, 2.4, True), (8, -38, 1.0, True), (-20, -3, 2.5, False), (-15, 61, 1.8, False), (-58, 0, 3, False)]
    for _ in range(650):
        craters.append((float(np.degrees(np.arcsin(rng.uniform(-0.97, 0.97)))), float(rng.uniform(-88, 88)), float(np.clip(rng.pareto(2.2) * 0.45 + 0.2, 0.2, 4)), False))
    for la, lo, rad, rays in craters:
        d = np.degrees(np.arccos(np.clip(np.sin(lat) * np.sin(np.radians(la)) + np.cos(lat) * np.cos(np.radians(la)) * np.cos(lon - np.radians(lo)), -1, 1)))
        near = d < rad * 2.2
        if not near.any():
            continue
        t = d[near] / rad
        height[near] += np.sqrt(rad) * (np.where(t < 1, (t**2 - 1) * 0.6, 0) + 0.25 * np.exp(-((t - 1) ** 2) / 0.04))
        if rays:
            ray = np.exp(-d / (rad * 5)) * 0.12
            albedo += np.where(d < rad * 9, ray, 0) * (0.6 + 0.4 * np.cos(np.arctan2(lat - np.radians(la), lon - np.radians(lo)) * 13) ** 6)
    height += 0.25 * fbm(H, W, 66, base=60, octaves=4)
    hy, hx = np.gradient(ndimage.gaussian_filter(height, 0.8))
    k = 0.012 * R / 8 * z  # slopes shrink toward the limb (foreshortening)
    nx, ny, nz = x - k * hx, y + k * hy, z
    nn = np.sqrt(nx * nx + ny * ny + nz * nz) + 1e-6
    sun = unit((0.80, 0.08, 0.60))  # waxing gibbous, lit from the right
    mu = np.clip((nx * sun[0] + ny * sun[1] + nz * sun[2]) / nn, 0, 1)
    # Lommel–Seeliger-like law: the Moon shows little limb darkening.
    lum = mu / (mu + np.maximum(z, 0.05)) * 2.0
    a = edge(on, x, y)
    body = (lum * np.clip(albedo, 0.15, 1))[..., None] * np.array([1.0, 0.97, 0.92], np.float32) * 1.15
    earthshine = (0.012 * np.clip(albedo, 0, 1))[..., None] * np.array([0.7, 0.8, 1.0], np.float32)
    img = img * (1 - a[..., None]) + (body + earthshine) * a[..., None]
    return np.asarray(img, np.float32)


def _planet(cx: float, cy: float, R: float, tilt: float, sun: tuple[float, float, float]) -> tuple[Arr, Arr, Arr, Arr, Arr, Arr, Arr]:
    on, x, y, z = sphere(cx, cy, R)
    bx, by, bz = rotate_normals(x, y, z, tilt)
    lat, lon = np.arcsin(np.clip(by, -1, 1)), np.arctan2(bx, bz)
    s = unit(sun)
    mu = np.clip(x * s[0] + y * s[1] + z * s[2], 0, 1)
    return edge(on, x, y), x, y, z, lat, lon, mu


def mars() -> Arr:
    img = sky(71)
    add_stars(img, 4000, 72, bright=0.6)
    a, x, y, z, lat, _lon, mu = _planet(W * 0.30, H * 0.56, H * 0.40, 18, (0.75, 0.25, 0.62))
    n = fbm(H, W, 73, base=8, octaves=8)
    dark = np.clip(fbm(H, W, 74, base=5, octaves=7) * 2.2 - 0.25, 0, 1)  # dark basaltic regions
    alb = 0.78 + 0.16 * n - 0.48 * dark
    base = np.array([0.86, 0.42, 0.22], np.float32)
    col = alb[..., None] * base + (dark * 0.06)[..., None] * np.array([0.2, 0.1, 0.05], np.float32)
    cap = np.clip((np.degrees(lat) - 68 - 4 * n) / 4, 0, 1)
    col = col * (1 - cap[..., None]) + cap[..., None] * np.array([0.95, 0.93, 0.92], np.float32)
    lum = mu**0.9 * (0.55 + 0.45 * z)  # some limb darkening and haze
    body = col * lum[..., None] * 1.25 + (np.exp(-z * 6) * mu)[..., None] * np.array([0.55, 0.35, 0.28], np.float32) * 0.35
    img = img * (1 - a[..., None]) + body * a[..., None]
    atmosphere(img, x, y, unit((0.75, 0.25, 0.62)), (0.9, 0.55, 0.40), 0.012, 0.35)
    return np.asarray(img, np.float32)


def jupiter() -> Arr:
    img = sky(81)
    add_stars(img, 3500, 82, bright=0.55)
    cx, cy, R = W * 0.66, H * 0.55, H * 0.47
    a, _x, _y, z, lat, lon, mu = _planet(cx, cy, R, 4, (0.55, 0.15, 0.82))
    la = np.degrees(lat)
    big = streaks(H, W, 83, stretch=5, base=5)
    fine = streaks(H, W, 84, stretch=9, base=24, octaves=6)
    eddy = warp(fbm(H, W, 85, base=40, octaves=5), big * 25, big * 4)
    lw = la + 1.6 * big + 0.9 * fine + 0.6 * eddy
    # Zones and belts by latitude (degrees north, colour), roughly like Jupiter's: bright Equatorial Zone, dark north and
    # south equatorial belts, then narrower bands toward the grey-blue poles.
    edges = np.array([-90, -50, -40, -33, -27, -20, -8, 7, 18, 24, 31, 37, 45, 90], np.float32)
    cols = np.array([[0.55, 0.57, 0.60], [0.70, 0.64, 0.56], [0.86, 0.80, 0.70], [0.68, 0.55, 0.45], [0.92, 0.88, 0.80], [0.66, 0.46, 0.34],
                     [0.95, 0.90, 0.80], [0.62, 0.42, 0.30], [0.93, 0.89, 0.80], [0.72, 0.56, 0.44], [0.90, 0.85, 0.76], [0.70, 0.62, 0.54],
                     [0.56, 0.58, 0.62]], np.float32)
    centres = (edges[:-1] + edges[1:]) / 2
    col = np.stack([np.interp(lw, centres, cols[:, c]) for c in range(3)], -1).astype(np.float32)
    col *= (0.93 + 0.08 * fine + 0.05 * eddy)[..., None]
    # Pale ovals and festoons along the belt edges.
    ov = np.clip(fbm(H, W, 86, base=50, octaves=3) * 2 - 1.2, 0, 1) * (np.abs(np.abs(la) - 30) < 4)
    col += ov[..., None] * 0.18
    # The Great Red Spot: an oval near 22° S.
    gx, gy = np.degrees(lon) + 18 + 0.6 * eddy, la + 22
    d = np.sqrt((gx / 11) ** 2 + (gy / 5.5) ** 2)
    spot = 1 / (1 + np.exp((d - 1) * 9))
    swirl = 0.9 + 0.1 * np.cos(d * 7 + eddy * 4)
    col = col * (1 - spot[..., None]) + spot[..., None] * np.array([0.78, 0.40, 0.27], np.float32) * swirl[..., None]
    col += (np.exp(-((d - 1.15) ** 2) / 0.02) * 0.05)[..., None]  # bright collar
    lum = mu**0.75 * (0.45 + 0.55 * z**0.4)
    img = img * (1 - a[..., None]) + col * lum[..., None] * 1.3 * a[..., None]
    return np.asarray(img, np.float32)


def saturn() -> Arr:
    """Saturn and its rings, ray-traced so the rings pass in front of and behind the planet and cast shadows."""
    img = sky(91)
    add_stars(img, 4000, 92, bright=0.55)
    cx, cy, R = W * 0.56, H * 0.52, H * 0.25
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    px, py = (xx - cx) / R, (cy - yy) / R
    # Ring plane normal tilted 24° toward the viewer, rolled 12° on the sky.
    tilt, roll = np.radians(24), np.radians(-12)
    nrm = np.array([np.sin(roll) * np.cos(tilt), np.cos(roll) * np.cos(tilt), np.sin(tilt)], np.float32)
    nrm /= np.linalg.norm(nrm)
    sun = unit((0.55, 0.35, 0.76))
    # Orthographic camera: rays travel along -z from z = +inf.
    rr = px * px + py * py
    hit_p = rr <= 1
    pz = np.sqrt(np.clip(1 - rr, 0, 1))
    # Ring plane through the origin: n·(px, py, t) = 0 → t.
    t_ring = -(nrm[0] * px + nrm[1] * py) / nrm[2]
    # Radius within the plane (oblate planet ignored).
    rx, ry, rz = px, py, t_ring
    rad = np.sqrt(rx * rx + ry * ry + rz * rz)

    def ring_profile(r: Arr) -> tuple[Arr, Arr]:
        """Opacity and brightness of the rings by radius (planet radii): C, B, Cassini Division, A, Encke Gap."""
        op = np.zeros_like(r)
        br = np.zeros_like(r)
        c = (r > 1.24) & (r < 1.53)
        b = (r >= 1.53) & (r < 1.95)
        a_ = (r >= 2.03) & (r < 2.27) & ~((r > 2.205) & (r < 2.215))
        fine = 0.85 + 0.15 * np.cos(r * 260) * np.cos(r * 97)
        op[c], br[c] = 0.18, 0.35
        op[b], br[b] = 0.92, 1.0
        op[a_], br[a_] = 0.62, 0.72
        return op * fine, br * fine

    op, rb = ring_profile(rad)
    # Planet colour: soft bands.
    nx_, ny_, nz_ = px, py, pz
    lat = np.arcsin(np.clip(nx_ * nrm[0] + ny_ * nrm[1] + nz_ * nrm[2], -1, 1))
    wob = fbm(H, W, 93, base=12, octaves=5)
    band = 0.5 + 0.5 * np.cos(np.degrees(lat + 0.01 * wob) * np.pi / 180 * 16)
    pcol = np.array([0.93, 0.83, 0.62], np.float32) * (1 - 0.18 * band[..., None])
    pole = np.clip((np.abs(np.degrees(lat)) - 60) / 20, 0, 1)
    pcol = pcol * (1 - pole[..., None]) + pole[..., None] * np.array([0.70, 0.72, 0.66], np.float32)
    mu = np.clip(nx_ * sun[0] + ny_ * sun[1] + nz_ * sun[2], 0, 1)
    # Ring shadow on the planet: from the surface point toward the sun, where does it cross the ring plane?
    sd = -(nx_ * nrm[0] + ny_ * nrm[1] + nz_ * nrm[2]) / float(nrm @ sun)
    sx, sy, sz = nx_ + sd * sun[0], ny_ + sd * sun[1], nz_ + sd * sun[2]
    sop, _ = ring_profile(np.sqrt(sx * sx + sy * sy + sz * sz))
    shadow_on_planet = np.where(sd > 0, sop, 0)
    planet = pcol * (mu * (0.5 + 0.5 * pz**0.3) * (1 - 0.85 * shadow_on_planet))[..., None] * 1.35
    # Planet shadow on the rings: does the ray from the ring point toward the sun hit the sphere?
    bq = rx * sun[0] + ry * sun[1] + rz * sun[2]
    cq = rad * rad - 1
    in_shadow = (bq < 0) & (bq * bq - cq > 0)
    lit_ring = np.where(in_shadow, 0.04, 1.0)
    ring_light = 0.35 + 0.65 * abs(float(nrm @ sun))
    ring_col = np.array([0.90, 0.82, 0.66], np.float32) * (rb * lit_ring * ring_light)[..., None] * 1.3
    # Composite: ring in front of the planet where its depth is above the planet surface.
    a_p = edge(hit_p, px, py)
    front = t_ring > pz
    behind_visible = ~hit_p
    out = img.copy()
    # Rings behind the planet only show outside the disc.
    m_back = (~front) & behind_visible
    out = np.where(m_back[..., None], out * (1 - op[..., None]) + ring_col * op[..., None], out)
    out = out * (1 - a_p[..., None]) + planet * a_p[..., None]
    m_front = front & (op > 0)
    out = np.where(m_front[..., None], out * (1 - op[..., None]) + ring_col * op[..., None], out)
    return np.asarray(out, np.float32)


def neptune() -> Arr:
    img = sky(101)
    add_stars(img, 5000, 102, bright=0.6)
    a, x, y, z, lat, lon, mu = _planet(W * 0.33, H * 0.50, H * 0.36, 20, (0.65, 0.30, 0.70))
    la = np.degrees(lat)
    wob = streaks(H, W, 103, stretch=6, base=8)
    band = 0.5 + 0.5 * np.cos(np.radians(la + 3 * wob) * 9)
    col = np.array([0.22, 0.42, 0.95], np.float32) * (0.88 + 0.12 * band[..., None])
    gx, gy = np.degrees(lon) + 10, la + 20
    spot = np.exp(-((gx / 9) ** 2 + (gy / 4) ** 2) ** 1.5)
    col = col * (1 - 0.55 * spot[..., None])
    clouds = np.clip(warp(fbm(H, W, 104, base=24, octaves=5), wob * 40, wob * 4) * 2 - 1.1, 0, 1) * (np.abs(la + 28) < 6)
    col = col + clouds[..., None] * np.array([0.8, 0.85, 0.9], np.float32)
    lum = mu**0.85 * (0.4 + 0.6 * z**0.5)
    img = img * (1 - a[..., None]) + col * lum[..., None] * 1.35 * a[..., None]
    atmosphere(img, x, y, unit((0.65, 0.30, 0.70)), (0.35, 0.6, 1.0), 0.015, 0.5)
    return np.asarray(img, np.float32)


SCENES: dict[str, tuple[Callable[[], Arr], float]] = {
    "milky-way": (milky_way, 1.4),
    "nebula": (nebula, 1.3),
    "spiral-galaxy": (spiral_galaxy, 1.3),
    "deep-field": (deep_field, 1.6),
    "starfield": (starfield, 1.4),
    "moon": (moon, 1.2),
    "mars": (mars, 1.2),
    "jupiter": (jupiter, 1.2),
    "saturn": (saturn, 1.2),
    "neptune": (neptune, 1.2),
}

if __name__ == "__main__":
    for name in sys.argv[1:] or list(SCENES):
        fn, exposure = SCENES[name]
        save(name, fn(), exposure)
