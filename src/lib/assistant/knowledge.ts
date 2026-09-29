// Knowledge base for the offline assistant. Each topic has keywords (with
// weights), optional phrase patterns, a short answer, a longer "more"
// answer for follow-ups, and suggested next questions.

export interface Topic {
  id: string;
  /** Short label used in "did you mean" suggestions. */
  title: string;
  /** Natural-language keywords; canonicalised by the engine. Weight defaults to 1. */
  keywords: Record<string, number>;
  /** Phrases that strongly indicate this topic. */
  phrases?: RegExp[];
  /** Score added when a phrase matches (default 3). */
  phraseBoost?: number;
  answer: string;
  more?: string;
  suggestions?: string[];
}

export const TOPICS: Topic[] = [
  // ── Tools ──────────────────────────────────────────────────────────────
  {
    id: 'forest',
    title: 'Estimate forest loss',
    keywords: { forest: 3, loss: 2, lost: 2, clearing: 2, change: 1, cut: 1, degradation: 2, regrowth: 1, gain: 1 },
    phrases: [/forest (loss|cover|change)/, /deforest/, /how much forest/, /trees? (cut|lost|removed)/],
    answer:
      '**Forest loss** (Tools → Forest loss) compares two dates:\n\n1. Upload an **earlier** and a **later** image of the same area, exported on the same grid (same region, scale and CRS). Each can be a single-band NDVI GeoTIFF, or a multi-band scene where you pick the red and NIR bands.\n2. Set the thresholds: forest = NDVI ≥ 0.5 on the earlier image; loss = a drop of 0.2 or more.\n3. Choose **Estimate forest loss** to get forest area, loss and regrowth in hectares plus a change map.\n\nNo data yet? Choose **Try synthetic sample**.',
    more:
      'Tips for reliable results:\n\n- Use images from the **same season** so leaf fall or crop cycles are not counted as loss.\n- Mask clouds and shadows first (the Earth Engine manual in Settings shows how).\n- NDVI thresholds are a proxy: they do not apply the FAO forest definition (≥ 0.5 ha, trees ≥ 5 m, ≥ 10 % canopy cover).\n- For official, consistent loss maps, switch the method to **Hansen Global Forest Change** and upload a lossyear tile.',
    suggestions: ['What is Hansen data?', 'How do I export NDVI from Earth Engine?', 'What is NDVI?'],
  },
  {
    id: 'hansen',
    title: 'Hansen Global Forest Change',
    keywords: { hansen: 3, lossyear: 3, treecover: 3, gfc: 3, umd: 2, 'global forest watch': 2, gfw: 2 },
    phrases: [/hansen/, /global forest (change|watch)/, /loss ?year/, /tree ?cover ?2000/],
    answer:
      'The **Hansen/UMD Global Forest Change** dataset (Hansen et al. 2013, *Science*) maps tree-cover loss worldwide at 30 m from Landsat. Its **lossyear** layer gives the year of stand-replacing loss (1 = 2001, 2 = 2002, …) and **treecover2000** gives canopy cover in 2000 for vegetation taller than 5 m.\n\nIn TerraX: Tools → Forest loss → **Hansen Global Forest Change**, upload the lossyear tile and optionally treecover2000. Loss is counted inside forest with canopy ≥ 30 % (adjustable) and reported by year.',
    more:
      'Get tiles from the Global Forest Watch data portal or Earth Engine (`UMD/hansen/global_forest_change_2023_v1_11` or the latest version). "Loss" includes harvest, fire, storms and disease, not only permanent deforestation, and algorithm updates mean early and recent years are not perfectly comparable.',
    suggestions: ['How do I estimate forest loss?', 'What canopy threshold should I use?'],
  },
  {
    id: 'carbon',
    title: 'Carbon & biomass',
    keywords: { carbon: 4, biomass: 4, co2: 3, sequestration: 3, allometry: 3, allometric: 3, dbh: 3, gbh: 3, girth: 2, inventory: 2, 'basal area': 3, stock: 1, 'forest capture': 3, agb: 3 },
    phrases: [/carbon|biomass|co2|co₂/, /allometr/, /basal area/, /forest[- ]?capture/, /wood density/],
    phraseBoost: 5,
    answer:
      '**Carbon & biomass** (Tools → Carbon & biomass) turns a tree inventory into biomass and carbon:\n\n1. Upload the **Forest-Capture** survey CSV, or any CSV with species, **DBH** (cm) or girth/**GBH** (cm), and ideally **height** (m), plus plot and plot size (m²).\n2. TerraX computes above-ground biomass per tree with **Chave et al. (2014)** (0.0673 × (ρD²H)^0.976), adds roots with the **IPCC 2006** root-to-shoot ratio for your forest zone, and converts to carbon (× 0.47) and CO₂e (× 44/12).\n3. You get t/ha with a 95 % interval across plots, basal area, stems/ha and a species table.\n\nTry **Try synthetic inventory** first.',
    more:
      'Accuracy tips:\n\n- **Wood density** matters as much as diameter: enter species values (Global Wood Density Database) instead of the 0.57 g/cm³ default.\n- **Measure heights** where you can; the diameter-only equations (Chave 2005 dry/moist/wet, or Chave 2014 eq. 7 with the site’s E value) are less accurate.\n- Dead stems and stumps are excluded; stems under the minimum DBH (default 5 cm) are left out.\n- The interval reflects variation between plots only, not allometric error, so use several plots.',
    suggestions: ['What is wood density?', 'How do I measure a plot?', 'How do I estimate forest loss?'],
  },
  {
    id: 'wooddensity',
    title: 'Wood density',
    keywords: { 'wood density': 5, density: 2, 'specific gravity': 4, rho: 2 },
    phrases: [/wood (specific )?(density|gravity)/],
    phraseBoost: 6,
    answer:
      '**Wood density** (ρ, oven-dry mass ÷ green volume, g/cm³) is how heavy a species’ wood is. Two trees with the same size can differ in biomass by a factor of two because of it, so allometric equations use D, H and ρ.\n\nTerraX uses **0.57 g/cm³** by default (the tropical Asian mean in Brown 1997, FAO) and lets you enter a value per species under Carbon & biomass → Method settings. Species values are in the **Global Wood Density Database** (Zanne et al. 2009).',
    suggestions: ['How do I estimate carbon?'],
  },
  {
    id: 'aoi',
    title: 'Analysis boundary',
    keywords: { clip: 4, aoi: 4, zonal: 4, 'analysis boundary': 5, 'area of interest': 5, restrict: 2, within: 1, inside: 1, mask: 1 },
    phrases: [/(clip|limit|restrict|only).{0,30}(boundary|plot|polygon|area)/, /analysis boundary/, /area of interest/, /zonal/, /inside (my|the) (plot|boundary)/],
    phraseBoost: 5,
    answer:
      'To analyse only your plot, set an **analysis boundary**:\n\n1. Open **Land survey** and load or draw the plot.\n2. Choose **Use as analysis boundary**. A banner shows it is active.\n3. Forest loss, Terrain and Satellite imagery then count only pixels whose centres fall inside the boundary, and the report says so.\n\nChoose **Clear boundary** to analyse whole images again. The raster must be WGS84, Web Mercator or UTM.',
    suggestions: ['Can I draw a plot on the map?', 'How do I estimate forest loss?'],
  },
  {
    id: 'draw',
    title: 'Draw and export a plot',
    keywords: { draw: 4, sketch: 3, digitise: 3, digitize: 3, vertex: 2, vertices: 2, export: 1, kml: 1, gpx: 1 },
    phrases: [/draw/, /(export|download|save).{0,20}(kml|gpx|geojson|boundary|plot)/, /edit (the )?(vertices|boundary|polygon)/],
    phraseBoost: 4,
    answer:
      'In **Land survey**, choose **Draw on map**, then click the map to add corners. Drag a corner to move it, double-click it to delete it, use **Undo**, and choose **Finish polygon** (at least three points). TerraX measures it like an uploaded file.\n\n**Edit on map** reopens a polygon for editing, and **Export** saves the result as **GeoJSON**, **KML** (Google Earth) or **GPX** (GPS units; polygons become closed tracks).',
    suggestions: ['How do I clip an analysis to my plot?', 'How accurate is the area?'],
  },
  {
    id: 'hydrology',
    title: 'Streams, watersheds and contours',
    keywords: { stream: 3, streams: 3, river: 2, drainage: 3, watershed: 4, catchment: 4, basin: 2, contour: 4, contours: 4, strahler: 4, flow: 2, accumulation: 3 },
    phrases: [/watershed|catchment|drainage (basin|network|density)/, /contour/, /stream (order|network)/, /flow (direction|accumulation)/],
    phraseBoost: 5,
    answer:
      'In **Terrain**, load a DEM and choose **Compute flow & streams**. TerraX fills depressions (Priority-Flood, Barnes et al. 2014), routes flow downhill with **D8**, and marks channels where the draining area exceeds your threshold (default 0.5 km²), with **Strahler** order.\n\nThen switch to **Flow & streams** and click a stream to outline its **watershed** (area, mean slope); you can use it as the analysis boundary or export it. **Contours** at your interval can be shown on the map and exported as GeoJSON.',
    more: 'The channel threshold is a modelling choice: smaller values draw more, shorter streams. D8 sends all flow to one neighbour, so it draws parallel lines on smooth planar slopes, and results depend on DEM quality (SRTM and Copernicus GLO-30 are surface models that include tree canopy and buildings).',
    suggestions: ['What is the hypsometric integral?', 'How do I clip an analysis to my plot?'],
  },
  {
    id: 'landcover',
    title: 'Land-cover classification',
    keywords: { 'land cover': 5, landcover: 5, classify: 3, classification: 3, cluster: 3, clusters: 3, kmeans: 4, 'k means': 4, unsupervised: 3, 'land use': 3 },
    phrases: [/land ?(cover|use)/, /classif/, /k ?-?means/, /cluster/],
    phraseBoost: 5,
    answer:
      '**Land cover** (Tools → Land cover) groups pixels with similar spectra using **k-means** (k-means++ seeding) on the bands you choose, maps the clusters and reports each one’s area and share. Name each cluster in the table; TerraX suggests names only from mean NDVI (water, bare/built-up, sparse vegetation, dense vegetation).\n\nTry **Try synthetic scene** first.',
    more: 'Clusters are spectral groups, not verified classes. Before reporting areas, check the map against reference points and use a stratified sample to estimate accuracy and area (Olofsson et al. 2014, Remote Sensing of Environment).',
    suggestions: ['What is NDVI?', 'How do I mask clouds?'],
  },
  {
    id: 'cloudmask',
    title: 'Cloud masks',
    keywords: { cloud: 4, clouds: 4, cloudy: 3, mask: 2, scl: 4, 'qa pixel': 4, qa: 2, shadow: 2, cirrus: 3 },
    phrases: [/cloud/, /\bscl\b/, /qa[_ ]?pixel/],
    phraseBoost: 4,
    answer:
      'Export the scene with its quality band, then in **Satellite imagery → Band roles** set **Cloud / quality band** and its type:\n\n- **Sentinel-2 SCL**: masks classes 0, 1, 3, 8, 9, 10, 11 (no data, defective, cloud shadow, clouds, cirrus, snow).\n- **Landsat QA_PIXEL**: masks bits 0–5 (fill, dilated cloud, cirrus, cloud, cloud shadow, snow).\n\nMasked pixels are left out of statistics, indices and composites; the report states the share removed.',
    suggestions: ['How do I export from earth engine', 'What is NDVI?'],
  },
  {
    id: 'mmu',
    title: 'Minimum mapping unit',
    keywords: { 'minimum mapping unit': 6, mmu: 5, patch: 3, patches: 3, 'small patches': 4, speckle: 3, noise: 1 },
    phrases: [/minimum mapping unit|\bmmu\b/, /small (patches|clearings)/, /(salt|speckle)/],
    phraseBoost: 5,
    answer:
      'In **Forest loss**, **Min. patch (ha)** ignores loss (or burned) patches smaller than that size. Pixels touching on any side or corner form one patch. 0 keeps every pixel; the FAO forest definition uses **0.5 ha**. The report lists how many patches were removed and their area, and **Export loss polygons** saves the remaining patches as GeoJSON.',
    suggestions: ['How do I estimate forest loss?', 'burn severity'],
  },
  {
    id: 'survey',
    title: 'Measure a plot (Land survey)',
    keywords: { survey: 3, area: 2, measure: 2, perimeter: 2, coordinates: 1, bearing: 2, distance: 1, boundary: 2, hectare: 1, acre: 1 },
    phrases: [/measure (a |my |the )?(plot|land|field|area)/, /plot area/, /how (big|large) is/],
    answer:
      '**Land survey** (Tools → Land survey) measures boundaries, tracks and points:\n\n1. Upload a GeoJSON, KML, GPX, CSV with lat/lon columns, or a zipped shapefile.\n2. TerraX reports **area** (m², ha, acres), **perimeter**, a **traverse table** (each leg’s distance and true bearing) and UTM/DMS coordinates, and draws the boundary on the map.\n\nFor a CSV of corner points, keep “CSV points form a closed boundary” ticked. Try **Try sample plot** first.',
    more:
      'How it measures: plots are projected to the UTM zone of their centroid and corrected by the point scale factor, which is accurate to well under 0.1 % on the WGS84 ellipsoid. Bearings are initial great-circle bearings from **true north**; a compass reads magnetic north, which differs by the local declination. The real limit is usually your GPS: phones are typically accurate to 3–10 m, worse under forest canopy.',
    suggestions: ['Convert 2 hectares to acres', 'Which file formats work?', 'Why is my survey file rejected?'],
  },
  {
    id: 'weather',
    title: 'Analyse weather and climate data',
    keywords: { weather: 3, climate: 3, rainfall: 2, temperature: 2, humidity: 2, moisture: 2, evapotranspiration: 2, radiation: 1, station: 1 },
    phrases: [/weather|climate/],
    answer:
      '**Weather & climate** (Tools → Weather & climate) analyses time series:\n\n1. Upload a CSV, TSV or XLSX with a **date column** and one or more variables (rainfall, temperature, humidity, soil moisture, evapotranspiration, solar radiation).\n2. Pick a variable. You get mean ± SD, range, a **Mann–Kendall trend test** with Theil–Sen slope, the monthly seasonal cycle, value classes and a table of values.\n\nFor daily rainfall you also get IMD rainy days (≥ 2.5 mm), the wettest day and the longest dry spell.',
    more:
      'Accepted dates: ISO (2024-06-01), day-first or month-first (01-06-2024), year-day (2024-153) or a year column. TerraX tells you if dates are ambiguous or invalid. Rainfall categories are only applied to daily totals, and a trend over less than two years is flagged as mostly seasonal.',
    suggestions: ['What does the trend test mean?', 'What are IMD rainfall categories?', 'How is soil moisture classified?'],
  },
  {
    id: 'satellite',
    title: 'Work with satellite imagery',
    keywords: { satellite: 3, imagery: 2, band: 2, composite: 2, 'false colour': 2, 'true colour': 2, spectral: 2, index: 1 },
    phrases: [/satellite|sentinel|landsat|multispectral/, /(true|false)[ -]colou?r/],
    answer:
      '**Satellite imagery** (Tools → Satellite imagery):\n\n1. Upload a multiband GeoTIFF (for example a Sentinel-2 or Landsat export).\n2. Open **Band roles and spectral indices** and confirm which band is blue, green, red, NIR, SWIR1 and SWIR2.\n3. Show a **true-colour** or **false-colour** composite, or compute NDVI, EVI, SAVI, NDWI, NDMI, NBR or NDBI.\n\nYou can also upload a vegetation-index time series (CSV) for trend analysis.',
    more:
      'Band numbers: Sentinel-2 uses B2 blue, B3 green, B4 red, B8 NIR, B11 SWIR1, B12 SWIR2; Landsat 8/9 uses B2–B4 visible, B5 NIR, B6 SWIR1, B7 SWIR2. Indices that use absolute reflectance (EVI, SAVI) need values from 0 to 1; TerraX divides by 10,000 when bands look scaled (as in Earth Engine Sentinel-2 L2A).',
    suggestions: ['What is NDVI?', 'What is NDWI?', 'What is a false-colour image?'],
  },
  {
    id: 'terrain',
    title: 'Slope and aspect from a DEM',
    keywords: { dem: 3, slope: 3, aspect: 3, hillshade: 2, contour: 1, relief: 1 },
    phrases: [/slope|aspect|hillshade/, /elevation model/],
    answer:
      '**Terrain** (Tools → Terrain): upload a DEM GeoTIFF with elevation in metres (SRTM, Copernicus GLO-30 or ASTER). TerraX computes **slope** and **aspect** with Horn’s (1981) method, slope classes, a **hillshade**, relief and the hypsometric integral.',
    more:
      'Slope is the steepness in degrees; aspect is the compass direction a slope faces (slopes under 2° count as flat). In Earth Engine, `USGS/SRTMGL1_003` (30 m) or `COPERNICUS/DEM/GLO30` are good sources; export in UTM so pixel sizes are in metres. Coarser DEMs give gentler slopes.',
    suggestions: ['What is the hypsometric integral?', 'What slope is too steep?'],
  },
  {
    id: 'photo',
    title: 'Green cover from photos',
    keywords: { photo: 3, drone: 2, aerial: 2, space: 2, iss: 2, greenness: 2, vari: 2, exg: 2, rgb: 1 },
    phrases: [/(space|aerial|drone) (image|photo)/, /from (a |my )?photo/],
    answer:
      '**Space & aerial photos** (Tools → Space & aerial photos): upload a JPG, PNG or WebP from a drone, aircraft, satellite snapshot or the ISS. TerraX estimates **green cover** with the Excess Green index and an automatic (Otsu) threshold, and reports **VARI** and colour statistics. Tick “Show vegetation mask” to see what was counted.',
    more:
      'Ordinary photos have no near-infrared band or calibrated reflectance, so haze, shadows and camera white balance change the result. Use it to compare images taken the same way; for NDVI use a multispectral GeoTIFF in Satellite imagery.',
    suggestions: ['What is VARI?', 'What is NDVI?'],
  },
  // ── Concepts ───────────────────────────────────────────────────────────
  {
    id: 'ndvi',
    title: 'What NDVI means',
    keywords: { ndvi: 4, vegetation: 2, greenness: 1, index: 1 },
    phrases: [/ndvi|normali[sz]ed difference vegetation/],
    answer:
      '**NDVI** (Normalized Difference Vegetation Index; Rouse et al. 1974) = (NIR − Red) / (NIR + Red). Healthy leaves reflect strongly in near-infrared and absorb red light, so NDVI rises with green vegetation.\n\n- Below 0: water, snow, clouds\n- 0–0.2: bare soil, rock, built-up\n- 0.2–0.5: sparse vegetation, grassland, crops\n- Above 0.6: dense green vegetation or forest\n\nThese ranges are indicative; they vary with sensor, season and region.',
    more:
      'NDVI saturates over dense canopy (it stops increasing), so EVI is often better in tropical forest. To compute it in TerraX, upload a multiband GeoTIFF in Satellite imagery and choose NDVI, or export NDVI directly from Earth Engine with `normalizedDifference([\'B8\', \'B4\'])` for Sentinel-2.',
    suggestions: ['What is EVI?', 'How do I export NDVI from Earth Engine?', 'How do I estimate forest loss?'],
  },
  {
    id: 'evi',
    title: 'What EVI means',
    keywords: { evi: 4, enhanced: 2 },
    phrases: [/\bevi\b|enhanced vegetation/],
    answer:
      '**EVI** (Enhanced Vegetation Index; Huete et al. 2002) = 2.5 (NIR − Red) / (NIR + 6 Red − 7.5 Blue + 1). It corrects for soil background and atmospheric effects and saturates less than NDVI over dense forest. Typical vegetated values are 0.2–0.8. It needs reflectance from 0 to 1.',
    suggestions: ['What is NDVI?', 'What is SAVI?'],
  },
  {
    id: 'savi',
    title: 'What SAVI means',
    keywords: { savi: 4, soil: 1, adjusted: 2 },
    phrases: [/\bsavi\b|soil[- ]adjusted/],
    answer: '**SAVI** (Soil-Adjusted Vegetation Index; Huete 1988) = 1.5 (NIR − Red) / (NIR + Red + 0.5). The 0.5 term reduces the effect of bright soil where vegetation is sparse, such as drylands or young plantations.',
    suggestions: ['What is NDVI?', 'What is EVI?'],
  },
  {
    id: 'ndwi',
    title: 'What NDWI means',
    keywords: { ndwi: 4, water: 2, flood: 2, river: 1, lake: 1 },
    phrases: [/ndwi|open water|flood/],
    answer:
      '**NDWI** (McFeeters 1996) = (Green − NIR) / (Green + NIR). Open water is usually **positive**, and vegetation and soil are negative, so it is used to map water bodies and floods. Sentinel-2: B3 and B8; Landsat 8/9: B3 and B5.\n\nDon’t confuse it with Gao’s (1996) index for vegetation water content, which TerraX calls **NDMI**.',
    suggestions: ['What is NDMI?', 'How do I compute an index?'],
  },
  {
    id: 'ndmi',
    title: 'What NDMI means',
    keywords: { ndmi: 4, moisture: 2, drought: 2, stress: 1 },
    phrases: [/ndmi|vegetation (water|moisture)|canopy moisture/],
    answer:
      '**NDMI** (Gao 1996) = (NIR − SWIR1) / (NIR + SWIR1). It tracks water in leaves: high values mean well-watered canopy and low values suggest drought stress or dry fuel. Sentinel-2: B8 and B11; Landsat 8/9: B5 and B6.',
    suggestions: ['How is soil moisture classified?', 'What is NBR?'],
  },
  {
    id: 'nbr',
    title: 'Burn severity (NBR)',
    keywords: { nbr: 4, burn: 3, fire: 3, dnbr: 3, severity: 2, wildfire: 3 },
    phrases: [/\bnbr\b|burn|wildfire|fire severity/],
    answer:
      '**NBR** (Normalized Burn Ratio; Key & Benson 2006) = (NIR − SWIR2) / (NIR + SWIR2). Healthy vegetation is high and fresh burn scars are low. Burn severity uses the difference **dNBR = NBR(before) − NBR(after)**. Indicative USGS classes: < 0.10 unburned, 0.10–0.27 low, 0.27–0.44 moderate-low, 0.44–0.66 moderate-high, > 0.66 high severity.',
    more: 'In TerraX, compute NBR for each date in Satellite imagery. For active fires, the NASA FIRMS link in the right panel shows near-real-time detections.',
    suggestions: ['What is NDMI?', 'How do I estimate forest loss?'],
  },
  {
    id: 'ndbi',
    title: 'Built-up areas (NDBI)',
    keywords: { ndbi: 4, urban: 3, built: 3, city: 2, settlement: 2, urbanisation: 3, urbanization: 3 },
    phrases: [/ndbi|built[- ]up|urbani[sz]ation/],
    answer: '**NDBI** (Zha et al. 2003) = (SWIR1 − NIR) / (SWIR1 + NIR). Built-up and bare surfaces are often **positive**, vegetation negative. Bare soil can also score high, so combine it with NDVI when mapping settlements.',
    suggestions: ['What is NDVI?', 'How do I compute an index?'],
  },
  {
    id: 'trend',
    title: 'The trend test (Mann–Kendall)',
    keywords: { trend: 4, significant: 2, 'p value': 2, pvalue: 2, slope: 1, increase: 1, decrease: 1 },
    phrases: [/mann|kendall|theil|sen'?s? slope|p[- ]value|significan/],
    answer:
      'TerraX tests trends with the **Mann–Kendall test**, a non-parametric test that asks whether values tend to rise or fall over time without assuming a straight line or normal data. If **p < 0.05**, the trend is called significant. The **Theil–Sen slope** is the median of all pairwise slopes, a robust “change per year” that is not thrown off by outliers.',
    more:
      'Caveats: the test assumes independent observations. Strong seasonality or autocorrelation can make p-values too small, so check the seasonal-cycle tab. Records shorter than about two years are flagged, because their “trend” is mostly the season.',
    suggestions: ['What is the seasonal cycle?', 'How do I analyse rainfall?'],
  },
  {
    id: 'imd',
    title: 'IMD rainfall categories',
    keywords: { imd: 4, category: 2, categories: 2, heavy: 2, light: 1, moderate: 1, 'rainy day': 3 },
    phrases: [/imd|rain(fall)? categor|heavy rain|rainy day/],
    answer:
      'TerraX uses the **India Meteorological Department** 24-hour rainfall categories: very light 0.1–2.4 mm, light 2.5–15.5, moderate 15.6–64.4, heavy 64.5–115.5, very heavy 115.6–204.4, extremely heavy ≥ 204.5 mm. A **rainy day** has at least 2.5 mm. They apply to daily totals only, so for other intervals TerraX shows quartiles instead.',
    suggestions: ['How do I analyse rainfall?', 'What does the trend test mean?'],
  },
  {
    id: 'soil',
    title: 'Soil moisture',
    keywords: { soil: 3, moisture: 3, smap: 3, vwc: 2 },
    phrases: [/soil moisture|smap/],
    answer:
      'Upload soil-moisture series in **Weather & climate**. TerraX reads volumetric water content in m³/m³ (or % and converts it) and applies indicative classes: < 0.10 very dry, 0.10–0.20 dry, 0.20–0.30 moderate, 0.30–0.40 moist, ≥ 0.40 wet. Field capacity and wilting point depend on soil texture, so these are guides only. Satellite products such as SMAP measure only the top ~5 cm.',
    suggestions: ['What is NDMI?', 'How do I analyse weather data?'],
  },
  {
    id: 'hypsometric',
    title: 'Hypsometric integral',
    keywords: { hypsometric: 4, integral: 2, erosion: 2, 'hi': 1 },
    phrases: [/hypsometr/],
    answer: 'The **hypsometric integral** (Strahler 1952) = (mean − min) / (max − min) elevation. Values above ~0.6 suggest a youthful, little-eroded landscape; about 0.35–0.6 mature; below ~0.35 an old, heavily eroded one. It is most meaningful for a whole catchment.',
    suggestions: ['How do I compute slope?'],
  },
  {
    id: 'slopeclass',
    title: 'Slope classes',
    keywords: { steep: 3, slope: 2, class: 1, gentle: 2, landslide: 2, cultivation: 1 },
    phrases: [/too steep|how steep|slope class/],
    answer: 'TerraX’s slope classes are descriptive: flat < 2°, gentle 2–5°, moderate 5–15°, steep 15–30°, very steep 30–45°, extreme ≥ 45°. Local land-use rules differ; many guidelines restrict cultivation above about 15–30°, and slopes over roughly 30° on weak soils are prone to landslides.',
    suggestions: ['How do I compute slope?', 'What is the hypsometric integral?'],
  },
  {
    id: 'vari',
    title: 'VARI and Excess Green',
    keywords: { vari: 4, exg: 4, excess: 2, visible: 1 },
    phrases: [/\bvari\b|excess green|\bexg\b/],
    answer: '**VARI** (Gitelson et al. 2002) = (G − R) / (G + R − B) and **Excess Green** (Woebbecke et al. 1995) = 2g − r − b on normalised colours. Both use only visible bands, so they work on ordinary photos, but they are less reliable than NIR indices like NDVI.',
    suggestions: ['What is NDVI?', 'How do I analyse a photo?'],
  },
  {
    id: 'crs',
    title: 'Coordinate systems (CRS, UTM)',
    keywords: { crs: 4, utm: 4, epsg: 4, projection: 3, wgs84: 3, 'coordinate system': 3, zone: 1, latlong: 2, reproject: 2 },
    phrases: [/\bcrs\b|\butm\b|epsg|projection|wgs ?84|coordinate system/],
    answer:
      'A **CRS** (coordinate reference system) says what coordinates mean. **WGS84 (EPSG:4326)** uses latitude/longitude in degrees. **UTM** splits the Earth into 60 zones 6° wide and uses metres. Kohima is in UTM zone 46N (EPSG:32646).\n\nTerraX reads rasters in WGS84, Web Mercator and WGS84 UTM, and vector files in WGS84 longitude/latitude (shapefiles are reprojected from their .prj).',
    more: 'If a GeoJSON or CSV has coordinates like 603000, 2846000, it is in a projected CRS: re-export it as EPSG:4326. For rasters, exporting in UTM gives pixel sizes in metres, which is best for area and slope.',
    suggestions: ['Which file formats work?', 'Why is my survey file rejected?'],
  },
  {
    id: 'formats',
    title: 'Supported file formats',
    keywords: { file: 3, upload: 3, format: 2, csv: 2, xlsx: 2, tif: 2, geojson: 2, kml: 2, gpx: 2, shapefile: 2, zip: 1, kmz: 2, xls: 2 },
    phrases: [/which (file|format)|what (file|format)|supported format|can i upload|how (do|can) i (upload|load|add)/],
    answer:
      'Each tool has its own upload box (drag and drop or click):\n\n- **GeoTIFF** (.tif): Forest loss, Satellite imagery, Terrain, climate grids\n- **Tables** (.csv, .tsv, .xlsx): Weather & climate, index time series\n- **Vectors** (.geojson, .kml, .gpx, CSV lat/lon, zipped shapefile): Land survey\n- **Photos** (.jpg, .png, .webp): Space & aerial photos\n\nFiles are read in your browser. Legacy .xls and .kmz need converting first (save as .xlsx; unzip the .kml).',
    suggestions: ['How do I measure a plot?', 'How do I estimate forest loss?', 'Is my data private?'],
  },
  {
    id: 'gee',
    title: 'Export data from Earth Engine',
    keywords: { gee: 4, export: 2, script: 2, sentinel: 1, download: 1, earthengine: 4 },
    phrases: [/earth ?engine|\bgee\b/],
    answer:
      'Open **Settings → Earth Engine manual** for step-by-step scripts. In short: define your area as `roi`, filter `COPERNICUS/S2_SR_HARMONIZED` by date and cloud cover, mask clouds with the SCL band, compute `normalizedDifference([\'B8\', \'B4\'])` for NDVI, then `Export.image.toDrive` with `scale: 10`. The manual also shows how to export an NDVI **time series** as CSV.',
    suggestions: ['What is NDVI?', 'How do I estimate forest loss?'],
  },
  {
    id: 'reports',
    title: 'Reports and downloads',
    keywords: { report: 4, pdf: 2, download: 2, save: 2, export: 2, markdown: 2, share: 1 },
    phrases: [/report|save (the |my )?result|download/],
    answer: 'After a tool runs, its **report** appears below the results. Choose **Save to Reports** to keep it (open the **Reports** tab to see, download or delete saved ones), or download it as **Markdown** or a text-based **PDF**. Table and raster tools also offer **Export summary (JSON)**.',
    suggestions: ['How do I set up AI?', 'Is my data private?'],
  },
  {
    id: 'ai',
    title: 'Set up AI (Gemini)',
    keywords: { ai: 4, apikey: 3, gemini: 3, online: 1, smarter: 2, offline: 2, chatbot: 1 },
    phrases: [/api ?key|gemini|set ?up ai|enable ai|turn on ai|smarter|offline/],
    answer:
      'I’m the **built-in offline guide**: I understand common questions about TerraX and Earth observation without internet. For open-ended questions, turn on AI: open **Settings**, paste a Gemini API key (from Google AI Studio) and save. The key stays in this browser. Alternatively, run TerraX with `GEMINI_API_KEY` set on the server so users never handle a key.',
    more: 'With AI on, the assistants send your question plus the computed results (and for tables a sample of up to 150 rows) to Google’s Gemini API. Without AI, everything is still computed locally; only these chat answers are simpler.',
    suggestions: ['Is my data private?', 'What can you do?'],
  },
  {
    id: 'privacy',
    title: 'Privacy and your data',
    keywords: { privacy: 4, private: 4, secure: 2, security: 2, server: 1, stored: 2, share: 1, safe: 2 },
    phrases: [/privacy|private|is my data|where .* stored|\bsafe\b|who can see/],
    phraseBoost: 5,
    answer: 'Your files are read **in your browser** and are not uploaded to a TerraX server. Saved reports and settings live in this browser’s local storage. Only when AI is turned on and you use an assistant or “Add AI interpretation” are the computed results (and for tables a sample of up to 150 rows) sent to Google’s Gemini API.',
    suggestions: ['How do I set up AI?'],
  },
  {
    id: 'telemetry',
    title: 'Planetary telemetry panel',
    keywords: { telemetry: 4, globe: 2, 'solar time': 3, 'equation of time': 3, zenith: 2, azimuth: 2, declination: 2 },
    phrases: [/telemetry|solar time|equation of time|zenith|sun position/],
    answer:
      'The left panel shows the **sun at your target location**:\n\n- **Mean solar time** = UTC + longitude ÷ 15.\n- **Apparent (sundial) time** adds the **equation of time**, which ranges from about −14 min in February to +16 min in November.\n- Sun **altitude**, **zenith angle** and **azimuth** (from true north), plus sunrise, sunset and day length.\n- The live **NOAA planetary K-index**.\n\nThe globe shows day and night. Change the target in Settings.',
    suggestions: ['What is the K-index?', 'When is sunrise?'],
  },
  {
    id: 'kp',
    title: 'Planetary K-index',
    keywords: { kp: 4, geomagnetic: 3, 'space weather': 3, storm: 2, solar: 1, gnss: 2, gps: 1, aurora: 2 },
    phrases: [/k[- ]?index|\bkp\b|geomagnetic|space weather/],
    answer: 'The **planetary K-index (Kp)** measures geomagnetic disturbance on a 0–9 scale for each 3-hour interval (NOAA SWPC). 0–2 is quiet, 3 unsettled, 4 active, and 5 or more is a geomagnetic storm (G1 minor at Kp 5 up to G5 extreme at Kp 9). Storms can degrade GNSS/GPS accuracy and HF radio.',
    suggestions: ['What does the telemetry panel show?'],
  },
  {
    id: 'reflectance',
    title: 'Reflectance scaling (×10,000)',
    keywords: { reflectance: 4, scaled: 3, scale: 2, '10000': 3, offset: 2, l2a: 3 },
    phrases: [/10,?000|reflectance|scale factor/],
    answer: 'Sentinel-2 Level-2A and many Earth Engine exports store surface reflectance as integers ×10,000 (so 0.25 is stored as 2500). Ratio indices like NDVI are unaffected, but EVI and SAVI need real reflectance, so TerraX divides by 10,000 when bands look scaled. Raw ESA L2A files from processing baseline 04.00 (January 2022) onward also carry a −1000 offset that must be removed first; the Earth Engine “HARMONIZED” collection already handles this.',
    suggestions: ['What is EVI?', 'How do I work with satellite imagery?'],
  },
  {
    id: 'samples',
    title: 'Sample data',
    keywords: { sample: 4, example: 3, demo: 3, test: 2, synthetic: 3 },
    phrases: [/sample|demo|example data|try (it|a tool)/],
    answer: 'Every tool has a **sample** button, so you can try it without your own files. The forest, terrain, satellite, survey and photo samples are **synthetic** (generated, not measured); the climate series are bundled demonstration data for Kohima whose source is undocumented. Don’t use either as research data.',
    suggestions: ['How do I estimate forest loss?', 'How do I measure a plot?'],
  },
  {
    id: 'errors',
    title: 'Troubleshooting',
    keywords: { error: 4, rejected: 3, 'not working': 3, wrong: 2, different: 1, grid: 1, invalid: 2 },
    phrases: [/(does ?n.?t|not|won.?t|can.?t|cannot|unable to|fails? to|failed to) (work|load|open|read|upload|import)|error|rejected|different grids|invalid|failed|broken|stuck/],
    phraseBoost: 6,
    answer:
      'Common fixes:\n\n- **“Different grids”** (Forest loss): export both dates with the same region, `scale` and `crs`.\n- **“Projected CRS”** (Land survey): re-export vectors as WGS84 (EPSG:4326).\n- **Shapefile**: zip the .shp, .shx, .dbf and .prj together.\n- **Dates not recognised**: use YYYY-MM-DD or one consistent day-first format.\n- **Values outside −1…1** for NDVI: it’s a multi-band scene, so assign the red and NIR bands.\n- **.xls / .kmz**: save as .xlsx / unzip to .kml.\n\nTell me the exact message and I’ll explain it.',
    suggestions: ['Which file formats work?', 'What is a CRS?'],
  },
  {
    id: 'map',
    title: 'The map',
    keywords: { map: 4, zoom: 2, pan: 1, tiles: 2, basemap: 2, navigate: 2 },
    phrases: [/\bmap\b/],
    answer: 'The map shows your target location and whatever a tool produces: raster footprints as a blue box, result maps (forest change, slope classes, raster layers) as an overlay, surveyed boundaries, and the analysis boundary as a dashed amber line. **Layers** (top right) turns each layer on or off, sets the overlay’s opacity and shows its legend. It zooms to new results once and then lets you pan and zoom freely. Online it uses the CARTO dark basemap (© OpenStreetMap contributors); offline it falls back to built-in country borders.',
    suggestions: ['How do I measure a plot?'],
  },
];

/** Tool shortcuts shown when the assistant greets or is unsure. */
export const STARTER_SUGGESTIONS = ['What can you do?', 'How do I estimate forest loss?', 'How do I measure a plot?', 'What is NDVI?'];
