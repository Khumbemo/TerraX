import { useState } from 'react';

const STEPS = [
  {
    title: 'Set up access',
    body: 'Open code.earthengine.google.com and sign in. Earth Engine needs a registered Google Cloud project (free for non-commercial and research use). Create a new script for your TerraX exports.',
    code: null,
  },
  {
    title: 'Define the study area',
    body: 'Search for your site (for example “Kohima, Nagaland”), draw a polygon with the geometry tools, then rename the import at the top of the script from “geometry” to “roi”. Or define it in code:',
    code: `// Example: a box around Kohima (lon/lat, WGS84)
var roi = ee.Geometry.Rectangle([94.05, 25.62, 94.16, 25.72]);
Map.centerObject(roi, 12);`,
  },
  {
    title: 'Select Sentinel-2 imagery',
    body: 'Use the harmonised Level-2A surface reflectance collection, filter to your area and dates, and mask clouds with the scene classification (SCL) band.',
    code: `function maskClouds(img) {
  var scl = img.select('SCL');
  // Keep vegetation (4), bare soil (5), water (6); drop cloud, shadow, cirrus, snow.
  var clear = scl.eq(4).or(scl.eq(5)).or(scl.eq(6));
  return img.updateMask(clear);
}

var s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
  .filterBounds(roi)
  .filterDate('2025-01-01', '2025-05-31')
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30))
  .map(maskClouds);`,
  },
  {
    title: 'Export an NDVI GeoTIFF',
    body: 'Compute NDVI from B8 (near-infrared) and B4 (red), take the median composite, and export it at 10 m. Upload the resulting .tif to TerraX. Alternatively export B4 and B8 together and use “Compute NDVI” in TerraX (band 1 = red, band 2 = NIR).',
    code: `var ndvi = s2.map(function (img) {
  return img.normalizedDifference(['B8', 'B4']).rename('NDVI');
}).median().clip(roi);

Export.image.toDrive({
  image: ndvi.toFloat(),
  description: 'TerraX_NDVI',
  region: roi,
  scale: 10,
  crs: 'EPSG:4326',
  maxPixels: 1e10
});`,
  },
  {
    title: 'Export an NDVI time series (CSV)',
    body: 'For trend analysis in TerraX, export the mean NDVI of the area for every image as a table with a date column. Run the task from the Tasks tab, then upload the CSV.',
    code: `var series = s2.map(function (img) {
  var mean = img.normalizedDifference(['B8', 'B4'])
    .reduceRegion({ reducer: ee.Reducer.mean(), geometry: roi, scale: 10, maxPixels: 1e10 })
    .get('nd');
  return ee.Feature(null, { date: img.date().format('YYYY-MM-dd'), NDVI: mean });
}).filter(ee.Filter.notNull(['NDVI']));

Export.table.toDrive({
  collection: series,
  description: 'TerraX_NDVI_series',
  fileFormat: 'CSV',
  selectors: ['date', 'NDVI']
});`,
  },
];

export default function GEEGuidance() {
  const [active, setActive] = useState(0);
  const step = STEPS[active];
  return (
    <div className="gee">
      <h3>Google Earth Engine export manual</h3>
      <p className="muted">These steps produce files TerraX can read: a Sentinel-2 NDVI GeoTIFF and an NDVI time-series CSV.</p>
      <div className="gee-layout">
        <ol className="gee-steps">
          {STEPS.map((s, i) => (
            <li key={s.title}>
              <button type="button" className={i === active ? 'active' : ''} aria-current={i === active ? 'step' : undefined} onClick={() => setActive(i)}>
                <span className="gee-num">{i + 1}</span> {s.title}
              </button>
            </li>
          ))}
        </ol>
        <div className="gee-body">
          <p>{step.body}</p>
          {step.code && (
            <pre className="code-block">
              <code>{step.code}</code>
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
