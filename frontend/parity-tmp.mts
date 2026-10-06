import { readFileSync } from 'node:fs';
import { openGeoTiff } from '/home/user/TerraX/frontend/src/lib/rasterio';
import { readRaster } from '/home/user/TerraX/frontend/src/lib/raster';
import { buildLocalReport } from '/home/user/TerraX/frontend/src/lib/report';
import { analyzeStack, stackMarkdown } from '/home/user/TerraX/frontend/src/lib/stack';
const S = '/home/user/TerraX/backend/data/samples/';
const f = (n: string) => new File([readFileSync(S + n)], n);
for (const view of [{ mode: 'band', band: 0 }, { mode: 'index', index: 'ndvi', bands: { red: 2, nir: 3 } }, { mode: 'index', index: 'evi', bands: { blue: 0, red: 2, nir: 3 } }] as any[]) {
  const ds = await readRaster(f('satellite_4band_synthetic.tif'), view);
  console.log(buildLocalReport(ds, null));
}
console.log(buildLocalReport(await readRaster(f('terrain_dem_synthetic.tif')), null));
const series = ['2019-03-10', '2020-03-14', '2021-03-09', '2022-03-12', '2023-03-15', '2024-03-11'].map(d => `series_ndvi_${d}_synthetic.tif`);
const items = [];
for (const s of series) items.push({ raster: await openGeoTiff(f(s)) });
console.log(stackMarkdown(await analyzeStack(items, { index: 'ndvi', bands: {} })));
