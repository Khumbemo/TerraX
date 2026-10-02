"""Builds TerraX's built-in world maps (public/data/maps/) from open datasets.

All outputs are in Web Mercator (EPSG:3857), cut at ±85.0511° like every web
map, so Leaflet can draw them tile by tile without reprojecting in the browser.

Sources (download them to a folder and pass it as the first argument):

  bmng.jpg, shadedrelief.jpg, etopo1.jpg
      From the basemap-data 2.0.0 wheel on PyPI (mpl_toolkits/basemap_data/).
      bmng.jpg     NASA Blue Marble Next Generation, visibleearth.nasa.gov (public domain), 5400x2700.
      shadedrelief.jpg  Tom Patterson, shadedrelief.com (public domain), 10800x5400.
      etopo1.jpg   NOAA ETOPO1 colour relief, ngdc.noaa.gov (public domain), 5400x2700.
  earth-night.jpg
      NASA Black Marble 2016 3 km composite (13500x6750, public domain), as shipped
      in github.com/krtbgb/dot-globe/assets (file dates April 2017 = the 2016 release).
  Biomes_Inventory_RasterStack.tif
      github.com/azizka/biomes data-raw (CC BY 4.0), 31 harmonised schemes, 10 km Mollweide
      (Fischer, Walentowitz & Beierkuhnlein 2022, Global Ecol. Biogeogr. 31:2172).
      Layer 3 = Beck et al. 2018 Köppen–Geiger 1980–2016; layer 5 = Dinerstein et al. 2017 biomes.
  ne_50m_admin_1_states_provinces_lines, ne_50m_rivers_lake_centerlines, ne_50m_lakes,
  ne_10m_populated_places_simple (.geojson)
      github.com/nvkelso/natural-earth-vector (public domain), default (de facto) worldview.
  PB2002_steps.json
      github.com/fraxen/tectonicplates (ODC-BY 1.0), from Bird (2003) G3 4(3):1027.

Requires: numpy, pillow, rasterio.  Usage: python3 scripts/make-world-maps.py <source-dir>
"""

import json
import sys
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.transform import from_bounds
from rasterio.warp import Resampling, reproject

Image.MAX_IMAGE_PIXELS = None
SRC = Path(sys.argv[1])
OUT = Path(__file__).resolve().parent.parent / 'public' / 'data' / 'maps'
OUT.mkdir(parents=True, exist_ok=True)

M = 20037508.342789244  # half the Web Mercator world width in metres
SIZE = 4096  # 9.8 km per pixel at the equator, finer towards the poles
DST_T = from_bounds(-M, -M, M, M, SIZE, SIZE)
DST_CRS = 'EPSG:3857'


def to_mercator(arr, src_transform, src_crs, resampling, nodata=None):
    out = np.zeros((arr.shape[0], SIZE, SIZE), dtype=arr.dtype)
    if nodata is not None:
        out[:] = nodata
    for b in range(arr.shape[0]):
        reproject(arr[b], out[b], src_transform=src_transform, src_crs=src_crs, src_nodata=nodata,
                  dst_transform=DST_T, dst_crs=DST_CRS, dst_nodata=nodata, resampling=resampling)
    return out


def image_layer(name, out_name, quality=82):
    im = np.asarray(Image.open(SRC / name).convert('RGB')).transpose(2, 0, 1)
    h, w = im.shape[1:]
    t = from_bounds(-180, -90, 180, 90, w, h)
    # Average when shrinking (Black Marble, relief), bilinear when enlarging toward the poles.
    merc = to_mercator(im, t, 'EPSG:4326', Resampling.average if w > SIZE * 2 else Resampling.bilinear)
    Image.fromarray(merc.transpose(1, 2, 0)).save(OUT / out_name, quality=quality, optimize=True, progressive=True)
    print(out_name, (OUT / out_name).stat().st_size)


# Köppen–Geiger colours from Beck et al. (2018) legend.txt; biome colours are TerraX's own.
KOPPEN = {
    'Af': (0, 0, 255), 'Am': (0, 120, 255), 'Aw': (70, 170, 250), 'BWh': (255, 0, 0), 'BWk': (255, 150, 150),
    'BSh': (245, 165, 0), 'BSk': (255, 220, 100), 'Csa': (255, 255, 0), 'Csb': (200, 200, 0), 'Csc': (150, 150, 0),
    'Cwa': (150, 255, 150), 'Cwb': (100, 200, 100), 'Cwc': (50, 150, 50), 'Cfa': (200, 255, 80), 'Cfb': (100, 255, 80),
    'Cfc': (50, 200, 0), 'Dsa': (255, 0, 255), 'Dsb': (200, 0, 200), 'Dsc': (150, 50, 150), 'Dsd': (150, 100, 150),
    'Dwa': (170, 175, 255), 'Dwb': (90, 120, 220), 'Dwc': (75, 80, 180), 'Dwd': (50, 0, 135), 'Dfa': (0, 255, 255),
    'Dfb': (55, 200, 255), 'Dfc': (0, 125, 125), 'Dfd': (0, 70, 95), 'ET': (178, 178, 178), 'EF': (102, 102, 102),
}
# Raster value -> code, from biomes_legend (layer 3) in the azizka/biomes package.
KOPPEN_VALUES = ['Af', 'Am', 'Aw', 'Cwc', 'BSh', 'Cwb', 'Cwa', 'BWh', 'Cfa', 'Csb', 'Dsa', 'Csc', 'Cfb', 'Csa', 'BWk',
                 'Dsb', 'BSk', 'Dwa', 'Dfa', 'Dwb', 'Cfc', 'Dfb', 'Dwc', 'ET', 'Dfc', 'Dsc', 'Dwd', 'Dfd', 'Dsd', 'EF']
BIOMES = [
    ('Tropical & subtropical moist broadleaf forests', (38, 115, 0)),
    ('Mangroves', (230, 0, 169)),
    ('Tropical & subtropical grasslands, savannas & shrublands', (204, 204, 102)),
    ('Tropical & subtropical dry broadleaf forests', (152, 196, 82)),
    ('Flooded grasslands & savannas', (115, 223, 255)),
    ('Tropical & subtropical coniferous forests', (90, 160, 90)),
    ('Deserts & xeric shrublands', (232, 196, 140)),
    ('Montane grasslands & shrublands', (200, 150, 110)),
    ('Mediterranean forests, woodlands & scrub', (255, 120, 60)),
    ('Temperate grasslands, savannas & shrublands', (245, 230, 120)),
    ('Temperate broadleaf & mixed forests', (60, 180, 110)),
    ('Temperate conifer forests', (0, 120, 110)),
    ('Boreal forests/taiga', (100, 150, 200)),
    ('Tundra', (180, 200, 220)),
    ('Rock & ice', (240, 240, 245)),
]


def class_layer(band, out_name, colours):
    with rasterio.open(SRC / 'Biomes_Inventory_RasterStack.tif') as r:
        a = r.read(band)
        a = np.where(np.isnan(a), 0, a).astype(np.uint8)[None]
        merc = to_mercator(a, r.transform, r.crs, Resampling.nearest, nodata=0)[0]
    im = Image.fromarray(merc, mode='P')
    pal = [0, 0, 0] + [c for rgb in colours for c in rgb]
    im.putpalette(pal + [0] * (768 - len(pal)))
    im.info['transparency'] = 0
    im.save(OUT / out_name, optimize=True, transparency=0)
    print(out_name, (OUT / out_name).stat().st_size)
    return merc


def rnd(coords, d=3):
    if coords and isinstance(coords[0], (int, float)):
        return [round(coords[0], d), round(coords[1], d)]
    return [r for r in (rnd(c, d) for c in coords) if r]


def vector(name, out_name, keep, where=lambda p: True, digits=3):
    src = json.loads((SRC / f'{name}.geojson').read_text())
    feats = []
    for f in src['features']:
        p = f['properties']
        if not f.get('geometry') or not where(p):
            continue
        feats.append({'type': 'Feature', 'properties': {k: p.get(k) for k in keep},
                      'geometry': {'type': f['geometry']['type'], 'coordinates': rnd(f['geometry']['coordinates'], digits)}})
    (OUT / out_name).write_text(json.dumps({'type': 'FeatureCollection', 'features': feats}, separators=(',', ':'), ensure_ascii=False))
    print(out_name, len(feats), (OUT / out_name).stat().st_size)


def places():
    src = json.loads((SRC / 'ne_10m_populated_places_simple.geojson').read_text())
    rows = []
    for f in src['features']:
        p = f['properties']
        lon, lat = f['geometry']['coordinates']
        # [name, lat, lon, min_zoom, population, 2 = national capital / 1 = other capital / 0]
        cap = 2 if p.get('adm0cap') == 1 else 1 if 'capital' in (p.get('featurecla') or '').lower() else 0
        rows.append([p['name'], round(lat, 3), round(lon, 3), p.get('min_zoom') or 10, int(p.get('pop_max') or 0), cap])
    rows.sort(key=lambda r: (r[3], -r[4]))
    (OUT / 'places.json').write_text(json.dumps(rows, separators=(',', ':'), ensure_ascii=False))
    print('places.json', len(rows), (OUT / 'places.json').stat().st_size)


def plates():
    """Joins Bird's (2003) 5,800 boundary steps into lines of one class per plate pair."""
    src = json.loads((SRC / "PB2002_steps.json").read_text())
    feats, cur = [], None
    for f in src['features']:
        p = f['properties']
        key = (p['PLATEBOUND'], p['STEPCLASS'])
        # Each step is a ~30 km great-circle arc; its two end points are enough at world scale.
        c = [f['geometry']['coordinates'][0], f['geometry']['coordinates'][-1]]
        joins = cur and cur['key'] == key and abs(cur['coords'][-1][0] - c[0][0]) < 1e-3 and abs(cur['coords'][-1][1] - c[0][1]) < 1e-3
        if joins:
            cur['coords'].extend(c[1:])
            cur['v'].append(p['VELOCITYLE'])
            cur['len'] += p['STEPLENGTH']
        else:
            if cur:
                feats.append(cur)
            cur = {'key': key, 'coords': list(c), 'v': [p['VELOCITYLE']], 'len': p['STEPLENGTH']}
    feats.append(cur)
    out = [{'type': 'Feature',
            'properties': {'b': k['key'][0], 'c': k['key'][1], 'v': round(float(np.mean(np.abs(k['v']))), 1)},
            'geometry': {'type': 'LineString', 'coordinates': rnd(k['coords'], 2)}} for k in feats]
    (OUT / 'plates.json').write_text(json.dumps({'type': 'FeatureCollection', 'features': out}, separators=(',', ':')))
    print('plates.json', len(out), (OUT / 'plates.json').stat().st_size)


if __name__ == '__main__':
    image_layer('bmng.jpg', 'bluemarble.jpg')
    image_layer('shadedrelief.jpg', 'relief.jpg')
    image_layer('etopo1.jpg', 'etopo.jpg', quality=72)
    image_layer('earth-night.jpg', 'blackmarble.jpg', quality=85)
    class_layer(3, 'koppen.png', [KOPPEN[c] for c in KOPPEN_VALUES])
    class_layer(5, 'biomes.png', [rgb for _, rgb in BIOMES])
    vector('ne_50m_admin_1_states_provinces_lines', 'admin1.json', [])
    vector('ne_50m_rivers_lake_centerlines', 'rivers.json', ['name', 'scalerank'])
    vector('ne_50m_lakes', 'lakes.json', ['name', 'scalerank'])
    places()
    plates()
