// Synthetic tree inventory in the Forest-Capture survey CSV layout
// (fictional plots and measurements, for trying the Carbon & biomass tool).
import { writeFileSync } from 'node:fs';

function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r = rng(2024);
const species = ['Schima wallichii', 'Castanopsis indica', 'Quercus serrata', 'Alnus nepalensis', 'Macaranga denticulata', 'Engelhardia spicata'];
const header = ['Survey', 'Date', 'Location', 'Investigator', 'Q#', 'Size', 'MeasDate', 'Observer', 'Species', 'Stage', 'Status', 'Phenology', 'Abundance', 'Stems', 'DBH', 'DBH_MeasHt', 'GBH', 'Height', 'CrownClass', 'CrownDiam', 'Distance', 'Azimuth', 'Health', 'Bark', 'DecayClass', 'GPS', 'Cover%', 'Stratum'];
const rows = [header];
for (let q = 1; q <= 5; q++) {
  const n = 9 + Math.floor(r() * 8);
  for (let i = 0; i < n; i++) {
    const sp = species[Math.floor(r() * species.length)];
    // Right-skewed diameters, 6–75 cm; height from a saturating H–D curve with noise.
    const dbh = Math.round((6 + 69 * r() ** 2.2) * 10) / 10;
    const height = Math.round((1.3 + 32 * (1 - Math.exp(-0.035 * dbh))) * (0.85 + 0.3 * r()) * 10) / 10;
    const status = r() < 0.06 ? 'dead-standing' : 'live';
    const useGbh = r() < 0.2;
    rows.push(['Demo survey (synthetic)', '2025-03-14', 'Fictional hill forest', 'TerraX sample', q, 400, '2025-03-14', '', sp, 'tree', status, '', 1, 1, useGbh ? 0 : dbh, 1.3, useGbh ? Math.round(dbh * Math.PI * 10) / 10 : 0, i % 7 === 3 ? 0 : height, '', 0, 0, 0, '', '', 0, '', 0, '']);
  }
  rows.push(['Demo survey (synthetic)', '2025-03-14', 'Fictional hill forest', 'TerraX sample', q, 400, '2025-03-14', '', 'Seedlings (mixed)', 'seedling', 'live', '', 12, 1, 0, 1.3, 0, 0.4, '', 0, 0, 0, '', '', 0, '', 0, '']);
}
rows.push([]);
rows.push(['--- TRANSECT DATA ---']);
rows.push(['Survey', 'T#', 'Method', 'Length', 'Width', 'Bearing', 'Slope', 'MeasDate', 'Observer', 'Species', 'LifeForm', 'IntType', 'StartDist', 'EndDist', 'Distance', 'Cover%', 'Height', 'DBH', 'Abundance']);
rows.push(['Demo survey (synthetic)', 1, 'line', 50, 2, 90, 5, '2025-03-14', '', 'Imperata cylindrica', 'grass', '', 0, 3, 3, 40, 0.8, 0, 1]);
const csv = rows.map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
writeFileSync(new URL('../public/data/samples/forest_capture_inventory_synthetic.csv', import.meta.url), '﻿' + csv);
console.log('wrote forest_capture_inventory_synthetic.csv', rows.length, 'rows');
