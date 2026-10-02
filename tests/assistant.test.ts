import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { OfflineAssistant } from '../src/lib/assistant/engine';
import { tokenMatch, tokens } from '../src/lib/assistant/nlp';
import { buildLocalReport } from '../src/lib/report';
import { parseDelimited } from '../src/lib/table';

const ctx = { operator: 'Asha Rao', target: { lat: 25.674, lon: 94.108, name: 'Kohima' }, now: new Date('2026-09-28T04:00:00Z') };

function ask(a: OfflineAssistant, q: string, c = ctx) {
  return a.reply(q, c);
}

test('small talk is recognised', () => {
  const a = new OfflineAssistant('guide');
  assert.match(ask(a, 'hi').text, /^Good (morning|afternoon|evening), Asha!/);
  assert.match(ask(a, 'Hello there').text, /TerraX assistant/);
  assert.match(ask(a, 'how are you?').text, /thanks for asking/);
  assert.match(ask(a, 'who are you').text, /built-in assistant/);
  assert.match(ask(a, 'what can you do').text, /what I can help with/);
  assert.match(ask(a, 'thanks!').text, /welcome/);
  assert.match(ask(a, 'ok bye').text, /Goodbye/);
  assert.match(ask(a, 'you are dumb').text, /Sorry/);
  assert.match(ask(a, 'asdfgh').text, /didn’t catch that/);
});

test('questions route to the right topic, typos included', () => {
  const cases: [string, string][] = [
    ['how do i calcualte forest los', 'forest'],
    ['what is ndvi', 'ndvi'],
    ['whats the Normalized Difference Vegetation Index', 'ndvi'],
    ['measure my plot', 'survey'],
    ['how big is my field', 'survey'],
    ['my shapefile wont load', 'errors'],
    ['is my data safe', 'privacy'],
    ['whats utm', 'crs'],
    ['what is kp', 'kp'],
    ['burn severity', 'nbr'],
    ['rain categories', 'imd'],
    ['soil moistur', 'soil'],
    ['how steep is too steep', 'slopeclass'],
    ['hansen lossyear', 'hansen'],
    ['open water index', 'ndwi'],
    ['how do I export from earth engine', 'gee'],
    ['set up gemini api key', 'ai'],
    ['what does the mann kendall p value mean', 'trend'],
    ['can i upload kml files', 'formats'],
    ['what is hypsometric integral', 'hypsometric'],
    ['how do I estimate carbon stock', 'carbon'],
    ['calculate biomass from dbh and height', 'carbon'],
    ['import my forest capture data', 'carbon'],
    ['what wood density should I use', 'wooddensity'],
    ['clip forest loss to my plot boundary', 'aoi'],
    ['only analyse pixels inside my plot', 'aoi'],
    ['can I draw a polygon on the map', 'draw'],
    ['export my boundary as kml', 'draw'],
    ['how much forest was lost', 'forest'],
    ['how do I delineate a watershed', 'hydrology'],
    ['can you draw contour lines', 'hydrology'],
    ['classify land cover from my image', 'landcover'],
    ['how do I remove clouds', 'cloudmask'],
    ['what is a minimum mapping unit', 'mmu'],
    ['what is ndvi', 'ndvi'],
    ['burn severity', 'nbr'],
    ['can I download rainfall data from era5', 'livedata'],
    ['find sentinel scenes for my area', 'livedata'],
    ['what does spi mean for drought', 'spi'],
    ['explain the seasonal kendall test', 'seasonalkendall'],
    ['monthly anomalies', 'seasonalkendall'],
    ['my neighbour built on my land', 'encroachment'],
    ['how to detect encroachment on my plot', 'encroachment'],
    ['illegal construction next to my property', 'encroachment'],
    ['measure my plot', 'survey'],
    ['how do I switch to openstreetmap', 'map'],
    ['change the base map to satellite', 'map'],
  ];
  for (const [q, id] of cases) assert.equal(new OfflineAssistant('guide').reply(q, ctx).topic, id, q);
});

test('follow-ups use conversation memory', () => {
  const a = new OfflineAssistant('guide');
  const first = ask(a, 'what is ndvi');
  assert.match(first.text, /Want more detail/);
  const more = ask(a, 'yes');
  assert.match(more.text, /saturates/);
  assert.match(ask(a, 'how?').text, /main point/); // no repeat of the same detail
  assert.equal(ask(a, 'and evi?').topic, 'evi');
  const b = new OfflineAssistant('guide');
  ask(b, 'how do I estimate forest loss');
  assert.match(ask(b, 'tell me more').text, /same season/);
  assert.match(ask(new OfflineAssistant('guide'), 'no thanks').text, /No problem/);
});

test('live answers: units, time and sunrise', () => {
  const a = new OfflineAssistant('guide');
  assert.match(ask(a, 'convert 2.5 acres to hectares').text, /2\.5 acres = 1\.01171 ha/);
  assert.match(ask(a, 'how many acres in a hectare').text, /1 ha = 2\.47105 acres/);
  assert.match(ask(a, '5000 m2 in ha').text, /= 0\.5 ha/);
  assert.match(ask(a, 'what time is it').text, /04:00 UTC/);
  const sun = ask(a, 'when is sunrise');
  assert.equal(sun.topic, 'sun');
  assert.match(sun.text, /Sunrise: .*\(23:3\d UTC\)/); // Kohima sunrise ≈ 05:05 IST on 28 Sep
});

test('results assistant answers from the computed results', () => {
  const text = readFileSync(new URL('../public/data/ndvi_data.csv', import.meta.url), 'utf8');
  const ds = parseDelimited(text, 'ndvi_data.csv', text.length);
  const results = { toolName: 'Satellite imagery', name: 'ndvi_data.csv', markdown: buildLocalReport(ds, 'NDVI'), dataset: ds, focus: 'NDVI' };
  const a = new OfflineAssistant('results');
  const c = { ...ctx, results };
  assert.match(ask(a, 'hi', c).text, /I can see your \*\*Satellite imagery\*\* results/);
  assert.match(ask(a, 'what is the peak', c).text, /highest \*\*NDVI\*\* is \*\*0\.8703\*\*/);
  assert.match(ask(a, 'lowest value?', c).text, /lowest \*\*NDVI\*\* is \*\*0\.5327\*\*/);
  assert.match(ask(a, 'is there a trend', c).text, /Mann–Kendall p = /);
  assert.match(ask(a, 'which month is highest', c).text, /Seasonal cycle/);
  assert.match(ask(a, 'summarise the results', c).text, /Here’s what TerraX found/);
  assert.match(ask(a, 'how reliable is this', c).text, /limits/);
  // Result rows from any tool's Markdown
  const forest = { toolName: 'Forest loss', name: 'a vs b', markdown: '## Results\n\n| Measure | Value |\n|---|---|\n| Forest at start (NDVI ≥ 0.5) | 3,911 ha |\n| Forest loss (ΔNDVI ≤ -0.2) | 184.05 ha |\n\n## Method and limits\n\n- NDVI thresholds are a proxy.' };
  assert.match(new OfflineAssistant('results').reply('how much forest was lost', { ...ctx, results: forest }).text, /Forest loss.*184\.05 ha/);
  // Knowledge questions still work in the results chat
  assert.equal(new OfflineAssistant('results').reply('what is ndvi', { ...ctx, results: { ...forest, markdown: forest.markdown + '\n| Mean ΔNDVI (all valid pixels) | -0.011 |' } }).topic, 'ndvi');
});

test('typo matching avoids short-word false positives', () => {
  assert.equal(tokenMatch('file', 'fire'), 0);
  assert.equal(tokenMatch('moistur', 'moisture'), 0.9);
  assert.equal(tokenMatch('calcualte', 'calculate'), 0.8);
  assert.deepEqual(tokens('How do I upload a GeoTIFF?'), ['upload', 'tif']);
});
