// Settings → About: who runs this server and how to reach them (set by its administrators in the Admin tab), TerraX's
// licence, and the licences of the data and software it uses.
import { useSite } from '../lib/site';

const DATA: [string, string][] = [
  ['OpenStreetMap', '© OpenStreetMap contributors, Open Database Licence (ODbL); used by the CARTO, OpenFreeMap, OpenTopoMap and Stadia basemaps.'],
  ['Natural Earth', 'Borders, coastlines, rivers, lakes and places: public domain.'],
  ['NASA', 'Blue Marble, Black Marble and GIBS imagery, and NASA POWER data: public domain (NASA). ETOPO1 relief: NOAA, public domain.'],
  ['Copernicus Sentinel-1 and Sentinel-2', 'Free and open under the Copernicus data terms. Results made from them contain modified Copernicus Sentinel data.'],
  ['Landsat', 'U.S. Geological Survey: public domain.'],
  ['EOX Sentinel-2 cloudless', '2016: CC BY 4.0; 2020: CC BY-NC-SA 4.0 (non-commercial use only).'],
  ['Open-Meteo', 'Weather data (ERA5 reanalysis): CC BY 4.0.'],
  ['Köppen–Geiger zones and RESOLVE biomes', 'Beck et al. (2018) and Dinerstein et al. (2017): CC BY 4.0.'],
  ['Tectonic plates', 'Bird (2003) PB2002 via Ahlenius/Nordpil: Open Data Commons Attribution.'],
  ['Esri, MapTiler, Stadia imagery and maps', 'Under each provider’s own terms (shown in Settings → Map when you choose them).'],
];

const SOFTWARE =
  'React (MIT), MapLibre GL JS (BSD-3-Clause), Recharts (MIT) and jsPDF (MIT) in the browser; FastAPI (MIT), Celery (BSD-3-Clause), GDAL (MIT), rasterio, GeoPandas, Shapely, NumPy, SciPy and scikit-learn (BSD-3-Clause) and Numba (BSD-2-Clause) on the server.';

export default function AboutTab() {
  const site = useSite();
  const c = site?.contact;
  const any = c && (c.contactName || c.contactEmail || c.supportEmail || c.supportUrl);
  return (
    <div className="prose" id="about-tab">
      <h3>About TerraX{site?.version ? ` ${site.version}` : ''}</h3>
      <p>
        TerraX is an Earth-observation workbench for climate, forest, water and land analysis: a React web app with MapLibre maps, and a Python server (FastAPI; rasterio,
        GeoPandas, scikit-learn, SciPy) that runs every analysis.
      </p>

      <h4>Contact and support</h4>
      {!site && <p className="field-hint">Loading…</p>}
      {site && !any && <p className="field-hint">The administrator of this server has not added contact details yet.</p>}
      {any && (
        <dl className="about-contact" id="about-contact">
          {c.contactName && (
            <>
              <dt>Run by</dt>
              <dd>{c.contactName}</dd>
            </>
          )}
          {c.contactEmail && (
            <>
              <dt>Enquiries</dt>
              <dd>
                <a href={`mailto:${c.contactEmail}`}>{c.contactEmail}</a>
              </dd>
            </>
          )}
          {c.supportEmail && (
            <>
              <dt>Technical support</dt>
              <dd>
                <a href={`mailto:${c.supportEmail}?subject=${encodeURIComponent('TerraX support')}`}>{c.supportEmail}</a>
              </dd>
            </>
          )}
          {c.supportUrl && (
            <>
              <dt>Help page</dt>
              <dd>
                <a href={c.supportUrl} target="_blank" rel="noopener noreferrer">
                  {c.supportUrl}
                </a>
              </dd>
            </>
          )}
        </dl>
      )}
      <p className="field-hint">When you report a problem, include what you did, the tool, and the reference number shown with any error message.</p>

      <h4>Licence</h4>
      <p>
        TerraX is open-source software under the <strong>MIT Licence</strong> (© TerraX authors). You may use, copy, change and share it, also commercially, as long as the
        copyright and licence notice stay with it. It comes <strong>without any warranty</strong>: check results before relying on them. The full text is in the LICENSE file of the
        source code.
      </p>

      <h4>Data</h4>
      <ul>
        {DATA.map(([name, text]) => (
          <li key={name}>
            <strong>{name}.</strong> {text}
          </li>
        ))}
      </ul>
      <p className="field-hint">
        Your uploads keep their own licences; credit the data sources above when you publish maps or results made with them. Most sample files are synthetic (made up for
        demonstration); the small Kohima sample tables have no documented source, so do not use them as research data.
      </p>

      <h4>Software</h4>
      <p>{SOFTWARE}</p>

      <h4>Services used when you ask for them</h4>
      <ul>
        <li>Live data, fetched by the server: Open-Meteo, NASA POWER, Earth Search (Sentinel-2) and the Microsoft Planetary Computer (Sentinel-1 and Landsat).</li>
        <li>Planetary K-index: NOAA Space Weather Prediction Center. Sun times: the formulas of aa.quae.nl and the NOAA Solar Calculator.</li>
        <li>AI (optional): the provider of the key you add (Gemini, Claude, OpenAI and others), under that provider’s terms.</li>
      </ul>
    </div>
  );
}
