// Tree biomass and carbon from field inventory (DBH, height, wood density).
//
// Above-ground biomass (AGB, kg dry matter per tree):
//  • with height:   Chave et al. 2014 (Glob. Change Biol. 20:3177), eq. 4:
//                   AGB = 0.0673 × (ρ D² H)^0.976   (D cm, H m, ρ g/cm³)
//  • without height, when the user gives the bioclimatic stress E: eq. 7:
//                   AGB = exp(−1.803 − 0.976 E + 0.976 ln ρ + 2.673 ln D − 0.0299 (ln D)²)
//  • without height or E: Chave et al. 2005 (Oecologia 145:87), model II.3
//                   AGB = ρ × exp(a + b ln D + 0.207 (ln D)² − 0.0281 (ln D)³)
//                   dry a=−0.667 b=1.784 · moist a=−1.499 b=2.148 · wet a=−1.239 b=1.980
// Below-ground biomass from IPCC (2006) Vol. 4 Table 4.4 root-to-shoot
// ratios; carbon fraction 0.47 (IPCC 2006 Table 4.3); CO₂e = C × 44/12.
import Papa from 'papaparse';
import { fmt } from '../stats';

export type ForestType = 'dry' | 'moist' | 'wet';

export const CHAVE2005: Record<ForestType, { a: number; b: number; label: string }> = {
  dry: { a: -0.667, b: 1.784, label: 'Dry (< 1,500 mm rain, > 5 dry months)' },
  moist: { a: -1.499, b: 2.148, label: 'Moist (1,500–3,500 mm rain)' },
  wet: { a: -1.239, b: 1.98, label: 'Wet (> 3,500 mm rain, no dry season)' },
};

/** IPCC 2006 Table 4.4 root-to-shoot ratios; thresholds are stand AGB in t/ha. */
export interface RootShootZone {
  id: string;
  label: string;
  /** Ratio for a stand with AGB `agbHa` t/ha. */
  ratio: (agbHa: number) => number;
  rule: string;
}

export const ROOT_SHOOT: RootShootZone[] = [
  { id: 'trop-rain', label: 'Tropical rainforest', ratio: () => 0.37, rule: '0.37' },
  { id: 'trop-moist', label: 'Tropical moist deciduous forest', ratio: a => (a < 125 ? 0.2 : 0.24), rule: '0.20 if AGB < 125 t/ha, else 0.24' },
  { id: 'trop-dry', label: 'Tropical dry forest', ratio: a => (a < 20 ? 0.56 : 0.28), rule: '0.56 if AGB < 20 t/ha, else 0.28' },
  { id: 'trop-shrub', label: 'Tropical shrubland', ratio: () => 0.4, rule: '0.40' },
  { id: 'trop-mountain', label: 'Tropical mountain systems', ratio: () => 0.27, rule: '0.27' },
  { id: 'temp-broadleaf', label: 'Temperate broadleaf forest', ratio: a => (a < 75 ? 0.46 : a <= 150 ? 0.23 : 0.24), rule: '0.46 if AGB < 75 t/ha, 0.23 for 75–150, 0.24 above' },
  { id: 'temp-conifer', label: 'Temperate conifer forest', ratio: a => (a < 50 ? 0.4 : a <= 150 ? 0.29 : 0.2), rule: '0.40 if AGB < 50 t/ha, 0.29 for 50–150, 0.20 above' },
];

export interface TreeRecord {
  plot: string;
  /** Plot (quadrat) area in m², 0 when unknown. */
  plotAreaM2: number;
  species: string;
  dbh: number | null;
  /** How DBH was obtained. */
  dbhFrom: 'DBH' | 'GBH' | null;
  height: number | null;
  status: string;
  /** Number of trees this row represents. */
  count: number;
  /** Measurement height of the diameter (m), when given. */
  measHeight: number | null;
}

export interface Inventory {
  filename: string;
  format: 'Forest-Capture' | 'Generic';
  trees: TreeRecord[];
  warnings: string[];
}

// ── Parsing ────────────────────────────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9#%]+/g, '');

function findCol(header: string[], names: string[]): number {
  const h = header.map(norm);
  for (const n of names) {
    const i = h.indexOf(norm(n));
    if (i >= 0) return i;
  }
  for (const n of names) {
    const i = h.findIndex(x => x.startsWith(norm(n)));
    if (i >= 0) return i;
  }
  return -1;
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const s = v.trim().replace(',', '.');
  if (!s || s === '—' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Reads a tree inventory CSV. Understands the Forest-Capture survey export
 * (Survey, Q#, Size, Species, Status, Abundance, DBH, DBH_MeasHt, GBH, Height)
 * and generic tables with species, DBH or girth (cm) and height (m) columns.
 */
export function parseInventory(text: string, filename: string): Inventory {
  const { data } = Papa.parse<string[]>(text.replace(/^﻿/, ''), { skipEmptyLines: false });
  const rows = data as string[][];
  const headerIdx = rows.findIndex(r => r.some(c => /^(dbh|gbh|girth|diameter|circumference|cbh)/i.test(c.trim())));
  if (headerIdx < 0) throw new Error(`${filename} has no DBH or girth (GBH) column. Add a column named DBH (cm) or GBH (cm).`);
  const header = rows[headerIdx].map(c => c.trim());
  const col = {
    survey: findCol(header, ['Survey']),
    plot: findCol(header, ['Q#', 'Quadrat', 'Plot', 'PlotID', 'Plot_ID', 'Subplot']),
    size: findCol(header, ['Size', 'PlotArea', 'Plot_area', 'Area_m2', 'Area']),
    species: findCol(header, ['Species', 'ScientificName', 'Taxon', 'Name']),
    status: findCol(header, ['Status', 'TreeStatus', 'Condition']),
    count: findCol(header, ['Abundance', 'Count', 'N', 'Trees']),
    dbh: findCol(header, ['DBH', 'DBH_cm', 'Diameter', 'D']),
    gbh: findCol(header, ['GBH', 'GBH_cm', 'Girth', 'CBH', 'Circumference']),
    height: findCol(header, ['Height', 'Height_m', 'H', 'TreeHeight']),
    measHt: findCol(header, ['DBH_MeasHt', 'MeasHeight', 'POM']),
  };
  const isFC = col.survey >= 0 && col.plot >= 0 && header.includes('DBH_MeasHt');
  const warnings: string[] = [];
  const trees: TreeRecord[] = [];
  let gbhUsed = 0;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    // Forest-Capture puts transect/point tables after a blank row and a "---" marker.
    if (r.every(c => !c.trim())) {
      if (isFC) break;
      continue;
    }
    if (/^---/.test(r[0]?.trim() ?? '')) break;
    const dbhRaw = col.dbh >= 0 ? num(r[col.dbh]) : null;
    const gbhRaw = col.gbh >= 0 ? num(r[col.gbh]) : null;
    let dbh: number | null = dbhRaw && dbhRaw > 0 ? dbhRaw : null;
    let dbhFrom: TreeRecord['dbhFrom'] = dbh ? 'DBH' : null;
    if (!dbh && gbhRaw && gbhRaw > 0) {
      dbh = gbhRaw / Math.PI;
      dbhFrom = 'GBH';
      gbhUsed++;
    }
    const h = col.height >= 0 ? num(r[col.height]) : null;
    const count = col.count >= 0 ? num(r[col.count]) : null;
    const plotName = [col.survey >= 0 ? r[col.survey]?.trim() : '', col.plot >= 0 ? r[col.plot]?.trim() : ''].filter(Boolean).join(' · ') || 'All trees';
    trees.push({
      plot: plotName,
      plotAreaM2: col.size >= 0 ? (num(r[col.size]) ?? 0) : 0,
      species: (col.species >= 0 ? r[col.species]?.trim() : '') || 'Unidentified',
      dbh,
      dbhFrom,
      height: h && h > 0 ? h : null,
      status: (col.status >= 0 ? r[col.status]?.trim().toLowerCase() : '') || 'live',
      // A measured tree is one individual in Forest-Capture; generic tables may give a count per row.
      count: isFC && dbh ? 1 : count && count > 0 ? Math.round(count) : 1,
      measHeight: col.measHt >= 0 ? num(r[col.measHt]) : null,
    });
  }
  if (!trees.length) throw new Error(`${filename} has a header but no tree rows.`);
  if (gbhUsed) warnings.push(`${gbhUsed} row${gbhUsed === 1 ? '' : 's'} had girth only; DBH = GBH / π.`);
  if (col.height < 0) warnings.push('No height column: biomass uses a diameter-only equation, which is less accurate.');
  return { filename, format: isFC ? 'Forest-Capture' : 'Generic', trees, warnings };
}

// ── Biomass ────────────────────────────────────────────────────────────────

export interface CarbonParams {
  /** Default wood density, g/cm³. */
  defaultDensity: number;
  /** Per-species wood density overrides, g/cm³. */
  densities: Record<string, number>;
  forestType: ForestType;
  /** Chave 2014 environmental stress E, when known for the site. */
  stressE: number | null;
  rootShoot: string;
  carbonFraction: number;
  minDbh: number;
  /** Used when the file gives no plot size (m²), 0 for none. */
  plotAreaM2: number;
}

export const DEFAULT_PARAMS: CarbonParams = {
  defaultDensity: 0.57,
  densities: {},
  forestType: 'moist',
  stressE: null,
  rootShoot: 'trop-moist',
  carbonFraction: 0.47,
  minDbh: 5,
  plotAreaM2: 0,
};

export type Equation = 'chave2014-h' | 'chave2014-e' | 'chave2005';

/** AGB in kg for one tree. */
export function treeAgb(d: number, h: number | null, rho: number, p: Pick<CarbonParams, 'forestType' | 'stressE'>): { agb: number; eq: Equation } {
  if (h !== null && h > 0) return { agb: 0.0673 * Math.pow(rho * d * d * h, 0.976), eq: 'chave2014-h' };
  const ln = Math.log(d);
  if (p.stressE !== null && Number.isFinite(p.stressE)) {
    return { agb: Math.exp(-1.803 - 0.976 * p.stressE + 0.976 * Math.log(rho) + 2.673 * ln - 0.0299 * ln * ln), eq: 'chave2014-e' };
  }
  const { a, b } = CHAVE2005[p.forestType];
  return { agb: rho * Math.exp(a + b * ln + 0.207 * ln * ln - 0.0281 * ln * ln * ln), eq: 'chave2005' };
}

export const basalAreaM2 = (dCm: number) => (Math.PI / 4) * (dCm / 100) ** 2;

export interface Totals {
  trees: number;
  basalArea: number; // m²
  agb: number; // kg
}

export interface PlotResult extends Totals {
  plot: string;
  areaM2: number;
  /** t/ha, null without a plot area */
  agbHa: number | null;
  baHa: number | null;
  stemsHa: number | null;
}

export interface SpeciesResult extends Totals {
  species: string;
  density: number;
  densityDefault: boolean;
  meanDbh: number;
}

export interface Estimate {
  mean: number;
  sd: number | null;
  ci95: [number, number] | null;
}

export interface CarbonResult {
  filename: string;
  format: Inventory['format'];
  live: Totals;
  plots: PlotResult[];
  species: SpeciesResult[];
  /** Per-hectare estimates across plots (null without plot areas). */
  perHa: {
    plots: number;
    areaHa: number;
    agb: Estimate;
    bgb: Estimate;
    carbon: Estimate;
    co2e: Estimate;
    basalArea: Estimate;
    stems: Estimate;
    rootShoot: number;
  } | null;
  /** Totals for the measured trees only (t). */
  measured: { agb: number; bgb: number; carbon: number; co2e: number; rootShoot: number };
  equations: Record<Equation, number>;
  diameterClasses: { label: string; trees: number; agb: number }[];
  excluded: { dead: number; small: number; noDiameter: number; large: number };
  qmd: number;
  notes: string[];
  warnings: string[];
}

/** Two-sided 95 % Student t quantile. */
export function t975(df: number): number {
  const T = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
  if (df < 1) return NaN;
  if (df <= 30) return T[Math.floor(df) - 1];
  // Interpolate linearly in 1/df between tabulated values (30, 40, 60, 120, ∞).
  const pts: [number, number][] = [[30, 2.042], [40, 2.021], [60, 2.0], [120, 1.98], [Infinity, 1.96]];
  for (let i = 0; i < pts.length - 1; i++) {
    const [d0, t0] = pts[i];
    const [d1, t1] = pts[i + 1];
    if (df <= d1) {
      const x0 = 1 / d0, x1 = d1 === Infinity ? 0 : 1 / d1, x = 1 / df;
      return t0 + ((x - x0) / (x1 - x0)) * (t1 - t0);
    }
  }
  return 1.96;
}

function estimate(values: number[]): Estimate {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, sd: null, ci95: null };
  const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1));
  const half = (t975(n - 1) * sd) / Math.sqrt(n);
  return { mean, sd, ci95: [mean - half, mean + half] };
}

const scale = (e: Estimate, k: number): Estimate => ({ mean: e.mean * k, sd: e.sd === null ? null : e.sd * k, ci95: e.ci95 ? [e.ci95[0] * k, e.ci95[1] * k] : null });

const DIAMETER_CLASSES = [5, 10, 20, 30, 40, 50, 60, 80, 100, Infinity];

export function computeCarbon(inv: Inventory, p: CarbonParams): CarbonResult {
  const zone = ROOT_SHOOT.find(z => z.id === p.rootShoot) ?? ROOT_SHOOT[1];
  const equations: Record<Equation, number> = { 'chave2014-h': 0, 'chave2014-e': 0, chave2005: 0 };
  const excluded = { dead: 0, small: 0, noDiameter: 0, large: 0 };
  const plots = new Map<string, PlotResult>();
  const species = new Map<string, SpeciesResult & { dSum: number }>();
  const classes = DIAMETER_CLASSES.slice(0, -1).map((lo, i) => ({ lo, hi: DIAMETER_CLASSES[i + 1], trees: 0, agb: 0 }));
  const live: Totals = { trees: 0, basalArea: 0, agb: 0 };
  let d2Sum = 0;
  let buttress = 0;
  const areaConflicts = new Set<string>();

  for (const t of inv.trees) {
    // Every plot counts in per-hectare means, even one with no measured trees.
    const area = t.plotAreaM2 > 0 ? t.plotAreaM2 : p.plotAreaM2;
    let pr = plots.get(t.plot);
    if (!pr) {
      pr = { plot: t.plot, areaM2: area, trees: 0, basalArea: 0, agb: 0, agbHa: null, baHa: null, stemsHa: null };
      plots.set(t.plot, pr);
    } else if (area > 0 && pr.areaM2 > 0 && Math.abs(area - pr.areaM2) > 1e-9) areaConflicts.add(t.plot);

    if (!/^live|^alive|^$/.test(t.status)) {
      excluded.dead += t.count;
      continue;
    }
    if (t.dbh === null) {
      excluded.noDiameter += t.count;
      continue;
    }
    if (t.dbh < p.minDbh) {
      excluded.small += t.count;
      continue;
    }
    if (t.dbh > 212) excluded.large += t.count; // outside Chave 2014 calibration; still included
    if (t.measHeight !== null && Math.abs(t.measHeight - 1.3) > 0.05) buttress += t.count;
    const rho = p.densities[t.species] ?? p.defaultDensity;
    const { agb, eq } = treeAgb(t.dbh, t.height, rho, p);
    equations[eq] += t.count;
    const ba = basalAreaM2(t.dbh);
    live.trees += t.count;
    live.basalArea += ba * t.count;
    live.agb += agb * t.count;
    d2Sum += t.dbh * t.dbh * t.count;
    pr.trees += t.count;
    pr.basalArea += ba * t.count;
    pr.agb += agb * t.count;
    let sp = species.get(t.species);
    if (!sp) {
      sp = { species: t.species, density: rho, densityDefault: !(t.species in p.densities), trees: 0, basalArea: 0, agb: 0, meanDbh: 0, dSum: 0 };
      species.set(t.species, sp);
    }
    sp.trees += t.count;
    sp.basalArea += ba * t.count;
    sp.agb += agb * t.count;
    sp.dSum += t.dbh * t.count;
    const c = classes.find(k => t.dbh! >= k.lo && t.dbh! < k.hi);
    if (c) {
      c.trees += t.count;
      c.agb += agb * t.count;
    }
  }

  const plotList = [...plots.values()];
  const withArea = plotList.filter(x => x.areaM2 > 0);
  for (const x of withArea) {
    const ha = x.areaM2 / 10_000;
    x.agbHa = x.agb / 1000 / ha;
    x.baHa = x.basalArea / ha;
    x.stemsHa = x.trees / ha;
  }
  const warnings = [...inv.warnings];
  if (areaConflicts.size) warnings.push(`Plots with rows giving different sizes (the first size was used): ${[...areaConflicts].slice(0, 5).join(', ')}.`);

  let perHa: CarbonResult['perHa'] = null;
  if (withArea.length && withArea.length === plotList.length) {
    const agb = estimate(withArea.map(x => x.agbHa!));
    const rs = zone.ratio(agb.mean);
    const bgb = scale(agb, rs);
    const carbon = scale(agb, (1 + rs) * p.carbonFraction);
    perHa = {
      plots: withArea.length,
      areaHa: withArea.reduce((a, x) => a + x.areaM2, 0) / 10_000,
      agb,
      bgb,
      carbon,
      co2e: scale(carbon, 44 / 12),
      basalArea: estimate(withArea.map(x => x.baHa!)),
      stems: estimate(withArea.map(x => x.stemsHa!)),
      rootShoot: rs,
    };
  } else if (withArea.length) {
    warnings.push(`${plotList.length - withArea.length} of ${plotList.length} plots have no size, so per-hectare values are not given. Enter a plot size to use for all plots.`);
  }

  const agbT = live.agb / 1000;
  const rsMeasured = perHa ? perHa.rootShoot : zone.ratio(Infinity);
  const measured = { agb: agbT, bgb: agbT * rsMeasured, carbon: agbT * (1 + rsMeasured) * p.carbonFraction, co2e: agbT * (1 + rsMeasured) * p.carbonFraction * (44 / 12), rootShoot: rsMeasured };

  const notes = [
    'Above-ground biomass per tree: Chave et al. (2014) pantropical equation AGB = 0.0673 × (ρD²H)^0.976 where height was measured.',
    p.stressE !== null
      ? `Trees without height: Chave et al. (2014) eq. 7 with the site’s environmental stress E = ${p.stressE}.`
      : `Trees without height: Chave et al. (2005) ${p.forestType}-forest equation (diameter and wood density only).`,
    `Wood density: ${fmt(p.defaultDensity, 3)} g/cm³ unless set per species${p.defaultDensity === 0.57 ? ' (0.57 is the tropical Asian mean of Brown 1997, FAO Forestry Paper 134)' : ''}. Species values from the Global Wood Density Database (Zanne et al. 2009) improve accuracy.`,
    `Below-ground biomass: IPCC (2006) root-to-shoot ratio for ${zone.label.toLowerCase()} (${zone.rule}); ${fmt(rsMeasured, 2)} applied.`,
    `Carbon = ${p.carbonFraction} × total biomass (IPCC 2006 default 0.47); CO₂e = C × 44/12.`,
    `Only live stems with DBH ≥ ${p.minDbh} cm are included; the Chave 2014 equation was calibrated on trees of 5–212 cm DBH.`,
    'The 95 % interval covers sampling variation between plots only; allometric-model error (residual SE 0.357 in log units for Chave 2014 eq. 4) and measurement error are not propagated.',
  ];
  if (excluded.dead) warnings.push(`${excluded.dead} dead stems or stumps were excluded from live biomass (dead wood needs a separate method).`);
  if (excluded.noDiameter) warnings.push(`${excluded.noDiameter} rows without a diameter (seedlings, herbs, counts) were left out.`);
  if (excluded.small) warnings.push(`${excluded.small} stems below ${p.minDbh} cm DBH were left out.`);
  if (excluded.large) warnings.push(`${excluded.large} trees exceed 212 cm DBH, beyond the Chave 2014 calibration range.`);
  if (buttress) warnings.push(`${buttress} trees were measured at a height other than 1.3 m (buttresses); their DBH was used as recorded.`);
  if (equations.chave2005 + equations['chave2014-e'] > 0 && equations['chave2014-h'] > 0) {
    warnings.push(`${equations.chave2005 + equations['chave2014-e']} of ${live.trees} trees had no height and used a diameter-only equation.`);
  }
  if (!perHa && live.trees) warnings.push('Without plot sizes the stand biomass class is unknown, so the root-to-shoot ratio for the highest biomass class was used.');
  if (!live.trees) warnings.push('No live trees with a diameter at or above the minimum were found.');

  return {
    filename: inv.filename,
    format: inv.format,
    live,
    plots: plotList,
    species: [...species.values()].map(({ dSum, ...s }) => ({ ...s, meanDbh: dSum / s.trees })).sort((a, b) => b.agb - a.agb),
    perHa,
    measured,
    equations,
    diameterClasses: classes.map(c => ({ label: c.hi === Infinity ? `≥ ${c.lo}` : `${c.lo}–${c.hi}`, trees: c.trees, agb: c.agb / 1000 })),
    excluded,
    qmd: live.trees ? Math.sqrt(d2Sum / live.trees) : NaN,
    notes,
    warnings,
  };
}

// ── Report ─────────────────────────────────────────────────────────────────

function est(e: Estimate, unit: string, sig = 4): string {
  const ci = e.ci95 ? ` (95 % CI ${fmt(Math.max(0, e.ci95[0]), sig)}–${fmt(e.ci95[1], sig)})` : '';
  return `${fmt(e.mean, sig)} ${unit}${ci}`;
}

export function carbonMarkdown(r: CarbonResult): string {
  const lines = ['## Dataset', '', `- File: ${r.filename} (${r.format} inventory); ${r.plots.length} plot${r.plots.length === 1 ? '' : 's'}; ${r.live.trees} live trees measured`, '', '## Results', ''];
  if (r.perHa) {
    lines.push(
      `Per hectare, from ${r.perHa.plots} plot${r.perHa.plots === 1 ? '' : 's'} covering ${fmt(r.perHa.areaHa, 3)} ha:`,
      '',
      '| Measure | Value |',
      '|---|---|',
      `| Above-ground biomass | ${est(r.perHa.agb, 't/ha')} |`,
      `| Below-ground biomass | ${est(r.perHa.bgb, 't/ha')} |`,
      `| Carbon stock (AGB + BGB) | ${est(r.perHa.carbon, 't C/ha')} |`,
      `| CO₂ equivalent | ${est(r.perHa.co2e, 't CO₂e/ha')} |`,
      `| Basal area | ${est(r.perHa.basalArea, 'm²/ha')} |`,
      `| Stem density | ${est(r.perHa.stems, 'stems/ha', 3)} |`,
      `| Quadratic mean diameter | ${fmt(r.qmd, 3)} cm |`,
      '',
    );
  }
  lines.push(
    'Measured trees only:',
    '',
    `- Above-ground biomass ${fmt(r.measured.agb, 4)} t; below-ground ${fmt(r.measured.bgb, 4)} t; carbon ${fmt(r.measured.carbon, 4)} t C; ${fmt(r.measured.co2e, 4)} t CO₂e`,
    `- Basal area ${fmt(r.live.basalArea, 4)} m²`,
    '',
    '### By species',
    '',
    '| Species | Trees | Mean DBH (cm) | Wood density | AGB (t) | Share of AGB |',
    '|---|---|---|---|---|---|',
    ...r.species.map(s => `| ${s.species} | ${s.trees} | ${fmt(s.meanDbh, 3)} | ${fmt(s.density, 3)}${s.densityDefault ? ' (default)' : ''} | ${fmt(s.agb / 1000, 4)} | ${((s.agb / (r.live.agb || 1)) * 100).toFixed(1)} % |`),
    '',
  );
  if (r.plots.length > 1 && r.perHa) {
    lines.push('### By plot', '', '| Plot | Area (m²) | Trees | AGB (t/ha) | Basal area (m²/ha) |', '|---|---|---|---|---|');
    lines.push(...r.plots.map(x => `| ${x.plot} | ${fmt(x.areaM2)} | ${x.trees} | ${x.agbHa === null ? '—' : fmt(x.agbHa, 4)} | ${x.baHa === null ? '—' : fmt(x.baHa, 4)} |`), '');
  }
  lines.push('### Diameter classes (cm)', '', ...r.diameterClasses.filter(c => c.trees).map(c => `- ${c.label}: ${c.trees} trees, ${fmt(c.agb, 3)} t AGB`), '');
  if (r.warnings.length) lines.push('## Data quality', '', ...r.warnings.map(w => `- ${w}`), '');
  lines.push('## Method and limits', '', ...r.notes.map(n => `- ${n}`));
  return lines.join('\n');
}
