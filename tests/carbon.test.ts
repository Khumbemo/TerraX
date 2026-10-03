import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEFAULT_PARAMS, basalAreaM2, carbonMarkdown, computeCarbon, parseInventory, t975, treeAgb } from '../src/lib/tools/carbon';

const close = (a: number, b: number, tol: number, msg?: string) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);

test('allometric equations match hand-computed values', () => {
  // Chave 2014 eq. 4: 0.0673 × (0.6 × 30² × 25)^0.976
  const h = treeAgb(30, 25, 0.6, DEFAULT_PARAMS);
  assert.equal(h.eq, 'chave2014-h');
  close(h.agb, 723.137, 0.01);
  // Chave 2005 moist, no height
  const m = treeAgb(30, null, 0.6, DEFAULT_PARAMS);
  assert.equal(m.eq, 'chave2005');
  close(m.agb, 724.109, 0.01);
  // Chave 2014 eq. 7 with E = 0.5
  const e = treeAgb(30, null, 0.6, { ...DEFAULT_PARAMS, stressE: 0.5 });
  assert.equal(e.eq, 'chave2014-e');
  close(e.agb, 386.042, 0.01);
  close(basalAreaM2(30), 0.0706858, 1e-6);
});

test('Student t quantiles', () => {
  close(t975(1), 12.706, 1e-9);
  close(t975(10), 2.228, 1e-9);
  assert.ok(t975(35) < 2.042 && t975(35) > 2.021);
  close(t975(1e9), 1.96, 1e-6);
});

test('per-hectare biomass, root:shoot and carbon for known plots', () => {
  const csv = ['Plot,Size,Species,DBH,Height,Status', 'A,400,Sp1,30,25,live', 'B,400,Sp1,30,25,live', 'B,400,Sp2,30,25,live', 'B,400,Sp2,3,2,live', 'B,400,Sp2,40,20,dead'].join('\n');
  const inv = parseInventory(csv, 't.csv');
  assert.equal(inv.format, 'Generic');
  const r = computeCarbon(inv, { ...DEFAULT_PARAMS, defaultDensity: 0.6 });
  const one = 723.1374 / 1000 / 0.04; // t/ha from one tree in 400 m²
  assert.equal(r.live.trees, 3);
  assert.equal(r.excluded.small, 1);
  assert.equal(r.excluded.dead, 1);
  close(r.perHa!.agb.mean, 1.5 * one, 1e-3);
  close(r.perHa!.agb.sd!, Math.SQRT1_2 * one, 1e-3);
  const half = (12.706 * Math.SQRT1_2 * one) / Math.SQRT2;
  close(r.perHa!.agb.ci95![1], 1.5 * one + half, 1e-3);
  // 27 t/ha < 125 → tropical moist deciduous ratio 0.20
  assert.equal(r.perHa!.rootShoot, 0.2);
  close(r.perHa!.carbon.mean, 1.5 * one * 1.2 * 0.47, 1e-3);
  close(r.perHa!.co2e.mean, 1.5 * one * 1.2 * 0.47 * (44 / 12), 1e-3);
  close(r.perHa!.stems.mean, 37.5, 1e-9);
  // Species override changes AGB proportionally to ρ^0.976
  const r2 = computeCarbon(inv, { ...DEFAULT_PARAMS, defaultDensity: 0.6, densities: { Sp2: 0.3 } });
  close(r2.species.find(s => s.species === 'Sp2')!.agb, 723.1374 * 0.5 ** 0.976, 1e-3);
  assert.match(carbonMarkdown(r), /Above-ground biomass \| 27\.12 t\/ha \(95 % CI/);
});

test('Forest-Capture export: quadrats, GBH, dead stems, seedlings and transect section', () => {
  const text = readFileSync(new URL('../public/data/samples/forest_capture_inventory_synthetic.csv', import.meta.url), 'utf8');
  const inv = parseInventory(text, 'fc.csv');
  assert.equal(inv.format, 'Forest-Capture');
  assert.ok(inv.trees.every(t => !/Imperata/.test(t.species)), 'transect rows must be ignored');
  assert.ok(inv.trees.some(t => t.dbhFrom === 'GBH'));
  const r = computeCarbon(inv, DEFAULT_PARAMS);
  assert.equal(r.plots.length, 5);
  assert.ok(r.plots.every(p => p.areaM2 === 400));
  assert.equal(r.excluded.noDiameter, 60); // 12 seedlings × 5 quadrats
  assert.ok(r.excluded.dead > 0);
  assert.ok(r.equations.chave2005 > 0 && r.equations['chave2014-h'] > 0);
  // Plausible hill-forest range for the synthetic data.
  assert.ok(r.perHa!.agb.mean > 20 && r.perHa!.agb.mean < 600, `AGB ${r.perHa!.agb.mean}`);
  const g = inv.trees.find(t => t.dbhFrom === 'GBH')!;
  assert.ok(g.dbh! > 5);
});

test('inventory without plot sizes and bad files', () => {
  const r = computeCarbon(parseInventory('Species,GBH\nA,94.2478\n', 'g.csv'), DEFAULT_PARAMS);
  close(r.qmd, 30, 1e-4);
  assert.equal(r.perHa, null);
  assert.ok(r.warnings.some(w => /root-to-shoot/.test(w)));
  const withArea = computeCarbon(parseInventory('Species,GBH\nA,94.2478\n', 'g.csv'), { ...DEFAULT_PARAMS, plotAreaM2: 1000 });
  assert.equal(withArea.perHa!.plots, 1);
  assert.throws(() => parseInventory('a,b\n1,2', 'x.csv'), /no DBH or girth/);
  assert.throws(() => parseInventory('DBH\n', 'x.csv'), /no tree rows/);
});
