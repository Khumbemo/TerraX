// Lightweight text understanding for the offline assistant: normalisation,
// tokenising, light stemming, synonyms and typo-tolerant word matching.

const CONTRACTIONS: [RegExp, string][] = [
  [/\bwhat's\b/g, 'what is'],
  [/\bhow's\b/g, 'how is'],
  [/\bit's\b/g, 'it is'],
  [/\bi'm\b/g, 'i am'],
  [/\byou're\b/g, 'you are'],
  [/\bcan't\b/g, 'can not'],
  [/\bdon't\b/g, 'do not'],
  [/\bdoesn't\b/g, 'does not'],
  [/\bisn't\b/g, 'is not'],
  [/\bwon't\b/g, 'will not'],
  [/\bi've\b/g, 'i have'],
  [/\bthat's\b/g, 'that is'],
  [/\bwhere's\b/g, 'where is'],
];

export const STOPWORDS = new Set(
  'a an the is are was were be been being am i me my we our you your it its this that these those of to in on at for from by with and or but if then so do does did can could would should will shall may might must about into over please pls kindly just tell show give explain know want need like get let us some any there here what which who whom whose how why when where'.split(
    ' ',
  ),
);

/** Words that change meaning a lot; kept even though they are short. */
const KEEP_SHORT = new Set(['ai', 'et', 'rh', 'sm', 'kp', 'gee', 'dem', 'crs', 'utm', 'lst', 'nir', 'pdf', 'csv', 'kml', 'gpx', 'imd', 'evi', 'nbr', 'hi', 'ok', 'no']);

/** Maps variants and common synonyms to one canonical word. */
const SYNONYMS: Record<string, string> = {
  hello: 'hi', hey: 'hi', hiya: 'hi', howdy: 'hi', namaste: 'hi', greetings: 'hi', yo: 'hi', hlo: 'hi', helo: 'hi',
  thank: 'thanks', thx: 'thanks', ty: 'thanks', thankyou: 'thanks', cheers: 'thanks',
  bye: 'bye', goodbye: 'bye', cya: 'bye',
  lost: 'loss', losing: 'loss', cleared: 'loss', gained: 'gain', regrowth: 'gain',
  deforestation: 'forest', trees: 'forest', tree: 'forest', woodland: 'forest', canopy: 'forest', logging: 'forest',
  plot: 'survey', boundary: 'survey', parcel: 'survey', field: 'survey', land: 'survey', traverse: 'survey', perimeter: 'survey',
  rain: 'rainfall', precipitation: 'rainfall', precip: 'rainfall', monsoon: 'rainfall', rainy: 'rainfall',
  temp: 'temperature', hot: 'temperature', cold: 'temperature', heat: 'temperature',
  humid: 'humidity', moist: 'moisture',
  image: 'imagery', images: 'imagery', picture: 'photo', photos: 'photo', pic: 'photo', photograph: 'photo', drone: 'photo', jpg: 'photo', jpeg: 'photo', png: 'photo',
  satellite: 'satellite', sentinel: 'satellite', landsat: 'satellite', scene: 'satellite', multispectral: 'satellite',
  elevation: 'dem', height: 'dem', altitude: 'dem', terrain: 'dem', topography: 'dem', relief: 'dem', srtm: 'dem', hill: 'dem', mountain: 'dem',
  steep: 'slope', gradient: 'slope', incline: 'slope',
  upload: 'upload', load: 'upload', import: 'upload', open: 'upload', add: 'upload', drop: 'upload', attach: 'upload',
  file: 'file', files: 'file', format: 'file', formats: 'file', data: 'file', dataset: 'file',
  report: 'report', reports: 'report', pdf: 'report', markdown: 'report', export: 'report', download: 'report', save: 'report',
  ai: 'ai', gemini: 'ai', key: 'ai', apikey: 'ai', llm: 'ai', chatgpt: 'ai',
  trend: 'trend', trends: 'trend', increasing: 'trend', decreasing: 'trend', mann: 'trend', kendall: 'trend', sen: 'trend', slope_trend: 'trend',
  sunrise: 'sunrise', sunset: 'sunset', dawn: 'sunrise', dusk: 'sunset',
  time: 'time', clock: 'time', date: 'date', today: 'date',
  area: 'area', acreage: 'area', size: 'area', hectare: 'hectare', hectares: 'hectare', ha: 'hectare', acre: 'acre', acres: 'acre',
  map: 'map', basemap: 'map', tiles: 'map',
  earthengine: 'gee', engine: 'gee',
  shp: 'shapefile', shapefiles: 'shapefile',
  geotiff: 'tif', tiff: 'tif', raster: 'tif', rasters: 'tif',
  wrong: 'error', broken: 'error', fail: 'error', failed: 'error', bug: 'error', crash: 'error', stuck: 'error', problem: 'error', issue: 'error',
};

/** Very light English stemmer: enough to join "computing/computed/computes". */
export function stem(w: string): string {
  if (w.length <= 4) return w;
  for (const suf of ['ations', 'ation', 'ings', 'ing', 'edly', 'ed', 'ies', 'es', 'ly', 's']) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) {
      const base = w.slice(0, -suf.length);
      return suf === 'ies' ? `${base}y` : base;
    }
  }
  return w;
}

export function normalize(text: string): string {
  let t = text.toLowerCase().replace(/[’‘]/g, "'");
  for (const [re, rep] of CONTRACTIONS) t = t.replace(re, rep);
  return t
    .replace(/earth engine/g, 'earthengine')
    .replace(/api key/g, 'apikey')
    .replace(/thank you/g, 'thankyou')
    .replace(/shape file/g, 'shapefile')
    .replace(/[^a-z0-9²\s.\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Raw words (after normalisation), including stopwords. */
export function words(text: string): string[] {
  return normalize(text)
    .split(' ')
    .map(w => w.replace(/^[.\-]+|[.\-]+$/g, ''))
    .filter(Boolean);
}

/** Content tokens: stopwords removed, synonyms mapped, stemmed. */
export function tokens(text: string): string[] {
  const out: string[] = [];
  for (const w of words(text)) {
    if (STOPWORDS.has(w)) continue;
    if (w.length < 3 && !KEEP_SHORT.has(w) && !/^\d/.test(w)) continue;
    const syn = SYNONYMS[w] ?? SYNONYMS[stem(w)];
    out.push(syn ?? stem(w));
  }
  return out;
}

/** Damerau–Levenshtein distance with an early exit above `max`. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

/**
 * How well a query token matches a keyword: 1 for an exact match, 0.9 for a
 * shared prefix of 5+ letters, 0.8 for a likely typo (one edit for words of
 * 5–7 letters, two for 8+), 0 otherwise. Short words must match exactly,
 * because one edit turns many of them into other words (file → fire).
 */
export function tokenMatch(q: string, k: string): number {
  if (q === k) return 1;
  if (q.length >= 5 && k.length >= 5 && (q.startsWith(k) || k.startsWith(q))) return 0.9;
  if (q.length < 5 || k.length < 5) return 0;
  const allowed = Math.min(q.length, k.length) >= 8 ? 2 : 1;
  return editDistance(q, k, allowed) <= allowed ? 0.8 : 0;
}
