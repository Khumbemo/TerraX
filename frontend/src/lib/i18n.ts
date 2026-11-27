// Interface language for the app's frame: navigation, start page, tool list, Settings and the tour. Tool screens and
// reports stay in English for now. English is built in; other languages load when chosen (src/lib/locales/*.ts).
// The translations were written with AI assistance and have not all been reviewed by native speakers; corrections are
// welcome (see the README).

export const LANGUAGES = [
  ['en', 'English', 'English'],
  ['zh', '简体中文', 'Chinese (Simplified)'],
  ['hi', 'हिन्दी', 'Hindi'],
  ['es', 'Español', 'Spanish'],
  ['fr', 'Français', 'French'],
  ['ar', 'العربية', 'Arabic'],
  ['bn', 'বাংলা', 'Bengali'],
  ['pt', 'Português', 'Portuguese'],
  ['ru', 'Русский', 'Russian'],
  ['ur', 'اردو', 'Urdu'],
  ['id', 'Bahasa Indonesia', 'Indonesian'],
  ['de', 'Deutsch', 'German'],
  ['ja', '日本語', 'Japanese'],
  ['ko', '한국어', 'Korean'],
  ['tr', 'Türkçe', 'Turkish'],
  ['vi', 'Tiếng Việt', 'Vietnamese'],
  ['sw', 'Kiswahili', 'Swahili'],
  ['it', 'Italiano', 'Italian'],
] as const;

export type Lang = (typeof LANGUAGES)[number][0];
export type Messages = Record<string, string>;

export const LANG_CODES = LANGUAGES.map(([code]) => code) as readonly Lang[];

/** Languages written right to left. */
export const RTL: readonly Lang[] = ['ar', 'ur'];

/** The supported language closest to the browser's own preferences, else English. */
export function browserLang(prefs: readonly string[] = typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language])): Lang {
  for (const p of prefs) {
    const base = p.toLowerCase().split('-')[0] as Lang;
    if (LANG_CODES.includes(base)) return base;
  }
  return 'en';
}

export const EN: Messages = {
  'nav.tools': 'Tools',
  'nav.reports': 'Reports',
  'nav.settings': 'Settings',
  'nav.end': 'End session',
  'hub.title': 'Tools',
  'hub.intro': 'Choose an analysis, then upload your GIS files. Every tool has sample data to try it first.',
  'hub.englishNote': '',
  'workspace.all': '← All tools',
  'session.subtitle': 'Earth observation workbench',
  'session.name': 'Your name (optional)',
  'session.hint': 'Shown on the reports you create.',
  'session.start': 'Start session',
  'session.note':
    "Files you add are uploaded to the TerraX server you are using and analysed there; only you can see them. As a guest they are deleted after a limited time (72 hours by default); with an account they are kept longer (30 days by default), with your history and projects. If you set up AI, a summary of the results is sent to Google's Gemini API when you ask for an interpretation.",
  'prefs.display': 'Display',
  'prefs.theme': 'Theme',
  'prefs.dark': 'Dark',
  'prefs.light': 'Light',
  'prefs.units': 'Units',
  'prefs.metric': 'Metric',
  'prefs.imperial': 'Imperial (US)',
  'prefs.unitsNote': 'Applies to values on screen; reports stay in SI units.',
  'prefs.language': 'Language',
  'prefs.galaxy': 'Galaxy',
  'prefs.background': 'Background',
  'prefs.bg.earthNight': 'Earth at night (city lights)',
  'prefs.panels': 'Panels',
  'prefs.panels.clear': 'Clear (more wallpaper)',
  'prefs.panels.balanced': 'Balanced',
  'prefs.panels.solid': 'Solid (easiest to read)',
  'prefs.bg.earth': 'Earth, live day and night',
  'prefs.bg.galaxy': 'Galaxy',
  'prefs.bg.custom': 'My own image',
  'prefs.bg.off': 'Off',
  'prefs.bg.choose': 'Choose image…',
  'prefs.bgNote':
    'The Earth is drawn from bundled Natural Earth land data. City lights come from 49,000 GeoNames places with 5,000+ people, sized and brightened by population: a model of where people live, not satellite night-light data. "Live day and night" uses the sun’s real position now. The background is hidden in the light theme.',
  'prefs.bg.space': 'Space pictures',
  'prefs.bg.milky-way': 'Milky Way',
  'prefs.bg.nebula': 'Nebula',
  'prefs.bg.spiral-galaxy': 'Spiral galaxy',
  'prefs.bg.deep-field': 'Deep field',
  'prefs.bg.starfield': 'Star field',
  'prefs.bg.moon': 'The Moon',
  'prefs.bg.mars': 'Mars',
  'prefs.bg.jupiter': 'Jupiter',
  'prefs.bg.saturn': 'Saturn',
  'prefs.bg.neptune': 'Neptune',
  'prefs.spaceNote':
    'Space pictures are artistic renderings made by TerraX (not photographs, not to scale), free to use under its MIT licence. For a real photograph, choose “My own image”: NASA images are generally not copyrighted, but check each image’s credit.',
  'prefs.intro': 'Opening animation',
  'prefs.introHint': 'Play the TerraX animation once each time the app opens',
  'prefs.tour': 'Take the tour',
  'tour.next': 'Next',
  'tour.back': 'Back',
  'tour.done': 'Done',
  'tour.skip': 'Skip',
  'tour.1.title': 'Pick a tool',
  'tour.1.text': 'Each card is one analysis: forest loss, carbon, land survey, weather, satellite imagery, land cover, terrain and photos. Every tool has sample data to try.',
  'tour.2.title': 'The map',
  'tour.2.text': 'Results appear here. Use Layers (top right) to switch layers on or off, change opacity and see the legend.',
  'tour.3.title': 'The assistant',
  'tour.3.text': 'It answers questions about the tools, terms and your results, even offline.',
  'tour.4.title': 'Reports',
  'tour.4.text': 'Saved reports live here. Download them as Markdown or as PDF with figures, and export the whole project.',
  'tour.5.title': 'Settings',
  'tour.5.text': 'Change the target location, AI, theme, units and language here.',
  'nav.assistant': 'Assistant',
  'nav.signin': 'Sign in',
  'gate.signin': 'Sign in',
  'gate.signinRest': 'to keep your analyses and projects on the server, or start as a guest.',
  'gate.signedIn': 'Signed in as {email}.',
  'settings.title': 'Settings & guide',
  'settings.tab.settings': 'Settings',
  'settings.tab.map': 'Map',
  'settings.tab.guide': 'How TerraX works',
  'settings.tab.gee': 'Earth Engine manual',
  'settings.tab.about': 'About, licences and support',
  'settings.close': 'Close',
  'prefs.telemetry': 'Telemetry',
  'prefs.telemetryHint': 'What the Planetary telemetry panel shows',
  'target.title': 'Telemetry target',
  'target.name': 'Name',
  'target.lat': 'Latitude (°N)',
  'target.lon': 'Longitude (°E)',
  'target.update': 'Update target',
  'target.hint': 'Used for solar time, sun position and the map marker. Use negative values for south and west.',
  'target.updated': 'Target location updated.',
  'target.invalid': 'Latitude must be between −90 and 90, and longitude between −180 and 180.',
  'tool.forest.name': 'Forest loss',
  'tool.forest.group': 'Forestry',
  'tool.forest.summary': 'Estimate where and how much forest was lost between two dates.',
  'tool.carbon.name': 'Carbon & biomass',
  'tool.carbon.group': 'Forestry',
  'tool.carbon.summary': 'Estimate tree biomass, carbon stock and CO₂ from a field inventory.',
  'tool.survey.name': 'Land survey',
  'tool.survey.group': 'Survey',
  'tool.survey.summary': 'Measure a plot boundary, walked traverse or set of points.',
  'tool.residential.name': 'Residential plot',
  'tool.residential.group': 'Property',
  'tool.residential.summary': 'Compare past and current images of your plot to spot encroachment and neighbouring expansion.',
  'tool.weather.name': 'Weather & climate',
  'tool.weather.group': 'Climate',
  'tool.weather.summary': 'Analyse rainfall, temperature, humidity, soil moisture, ET and radiation series.',
  'tool.satellite.name': 'Satellite imagery',
  'tool.satellite.group': 'Remote sensing',
  'tool.satellite.summary': 'Explore multispectral scenes and compute spectral indices.',
  'tool.landcover.name': 'Land cover',
  'tool.landcover.group': 'Remote sensing',
  'tool.landcover.summary': 'Group pixels into spectral classes, name them and measure their areas.',
  'tool.radar.name': 'Radar (Sentinel-1)',
  'tool.radar.group': 'Remote sensing',
  'tool.radar.summary': 'Backscatter through cloud: speckle filtering, polarisation indices and change between two dates.',
  'tool.water.name': 'Water & floods',
  'tool.water.group': 'Remote sensing',
  'tool.water.summary': 'Map open water from optical or radar images, floods between two dates, and how often water was present over many dates; list every lake and pond.',
  'tool.canopy.name': 'Canopy height',
  'tool.canopy.group': 'Elevation',
  'tool.canopy.summary': 'Canopy height, cover and tree tops from LiDAR or surface and terrain models.',
  'tool.terrain.name': 'Terrain',
  'tool.terrain.group': 'Elevation',
  'tool.terrain.summary': 'Derive slope, aspect, relief, streams and watersheds from an elevation model.',
  'tool.photo.name': 'Space & aerial photos',
  'tool.photo.group': 'Imagery',
  'tool.photo.summary': 'Estimate green cover in images from satellites, drones or the ISS.',
};

/** The messages of a language other than English, loaded on demand. */
export async function loadMessages(lang: Lang): Promise<Messages> {
  if (lang === 'en') return EN;
  const mods = import.meta.glob<{ default: Messages }>('./locales/*.ts');
  const load = mods[`./locales/${lang}.ts`];
  return load ? (await load()).default : EN;
}

/** Translation for `key` in `messages`, falling back to English and then to `fallback`. `{name}` is replaced from vars. */
export function translate(messages: Messages, key: string, fallback = '', vars?: Record<string, string>): string {
  let s = messages[key] ?? EN[key] ?? fallback;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(v);
  return s;
}
