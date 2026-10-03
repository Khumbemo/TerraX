// The sandboxed preview host does not serve .tif files, so the preview build
// ships GeoTIFF samples base64-encoded as <name>.tif.b64.txt (decoded by
// src/lib/samples.ts when __TERRAX_PREVIEW__ is set).
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const dir = new URL('../dist-preview/data/samples/', import.meta.url);
for (const name of readdirSync(dir).filter(n => /\.tiff?$/i.test(n))) {
  writeFileSync(new URL(`${name}.b64.txt`, dir), readFileSync(new URL(name, dir)).toString('base64'));
  rmSync(new URL(name, dir));
  console.log('encoded', name);
}
