import { useEffect, useState } from 'react';
import { MAPS, gibsDefaultDate, type MapGroup } from '../lib/basemaps';
import { getLocalPmtiles, loadLocalPmtiles, onLocalPmtilesChange, setLocalPmtiles } from '../lib/pmtiles-store';
import { usePrefs } from '../lib/prefs';
import { useToast } from '../lib/toast';
import MapChooser from './MapChooser';

const GROUPS: MapGroup[] = ['Offline', 'Street maps', 'Vector maps', 'Terrain', 'Satellite', 'Night lights', 'Your own'];

/** Settings → Map: base map and overlays, keys, dates and your own sources. */
export default function MapSettingsTab() {
  const { map, updateMap } = usePrefs();
  const notify = useToast();
  const [file, setFile] = useState<File | null>(getLocalPmtiles());
  useEffect(() => {
    loadLocalPmtiles().then(setFile);
    return onLocalPmtilesChange(() => setFile(getLocalPmtiles()));
  }, []);
  const uses = (pred: (id: string) => boolean) => pred(map.base) || map.overlays.some(o => pred(o.id));

  return (
    <div className="settings-stack map-settings">
      <section>
        <h3>Map</h3>
        <p className="field-hint">Choose one base map and stack any number of overlays on top, each with its own opacity. The same controls are in the map’s Layers panel.</p>
        <MapChooser idPrefix="settings-map" />
        {__TERRAX_PREVIEW__ && <p className="notice">This preview runs in a sandbox that blocks map servers, so online maps will not load here; the offline outlines are shown instead. Run TerraX locally to use them.</p>}
      </section>

      <section>
        <h3>API keys (only for maps that need one)</h3>
        <div className="param-row">
          <label className="param">
            <span>Stadia Maps</span>
            <input id="map-key-stadia" type="password" autoComplete="off" placeholder="optional on localhost or a registered domain" value={map.keys.stadia ?? ''} onChange={e => updateMap({ keys: { ...map.keys, stadia: e.target.value } })} />
          </label>
          <label className="param">
            <span>MapTiler</span>
            <input id="map-key-maptiler" type="password" autoComplete="off" placeholder="required for MapTiler maps" value={map.keys.maptiler ?? ''} onChange={e => updateMap({ keys: { ...map.keys, maptiler: e.target.value } })} />
          </label>
        </div>
        <p className="field-hint">Keys stay in this browser. Map keys are sent to the map provider with each tile request (that is how these services work), so use keys restricted to your domain.</p>
      </section>

      <section>
        <h3>NASA daily imagery date</h3>
        <div className="param-row">
          <label className="param">
            <span>Date (UTC)</span>
            <input id="map-gibs-date" type="date" max={gibsDefaultDate()} min="2000-02-24" value={map.gibsDate} onChange={e => updateMap({ gibsDate: e.target.value })} />
          </label>
          {map.gibsDate && (
            <button type="button" className="btn btn-small" onClick={() => updateMap({ gibsDate: '' })}>
              Use yesterday
            </button>
          )}
        </div>
        <p className="field-hint">
          For the MODIS and VIIRS true-colour layers. Empty = yesterday ({gibsDefaultDate()}), because today’s mosaic is usually incomplete. MODIS Terra starts in 2000, VIIRS SNPP in
          late 2015; clouds are part of the picture.
        </p>
      </section>

      <section>
        <h3>Your own map sources</h3>
        <div className="param-stack">
          <label className="param wide">
            <span>Tile URL (XYZ)</span>
            <input id="map-custom-xyz" type="url" placeholder="https://example.org/tiles/{z}/{x}/{y}.png" value={map.customXyz.url} onChange={e => updateMap({ customXyz: { ...map.customXyz, url: e.target.value } })} />
          </label>
          <label className="param wide">
            <span>Attribution</span>
            <input type="text" placeholder="© Provider" value={map.customXyz.attribution} onChange={e => updateMap({ customXyz: { ...map.customXyz, attribution: e.target.value } })} />
          </label>
          <label className="param wide">
            <span>WMS address</span>
            <input id="map-custom-wms" type="url" placeholder="https://…/wms" value={map.customWms.url} onChange={e => updateMap({ customWms: { ...map.customWms, url: e.target.value } })} />
          </label>
          <label className="param wide">
            <span>WMS layer name(s)</span>
            <input id="map-custom-wms-layers" type="text" placeholder="layer1,layer2" value={map.customWms.layers} onChange={e => updateMap({ customWms: { ...map.customWms, layers: e.target.value } })} />
          </label>
          <label className="param wide">
            <span>WMS attribution</span>
            <input type="text" placeholder="© Provider" value={map.customWms.attribution} onChange={e => updateMap({ customWms: { ...map.customWms, attribution: e.target.value } })} />
          </label>
        </div>
        <p className="field-hint">
          Then pick “Custom tile URL” or “Custom WMS” as the base map or an overlay. For ISRO Bhuvan, copy the WMS address and layer name of the theme you want from bhuvan.nrsc.gov.in
          (its services and terms change, so TerraX does not hard-code them).
        </p>
      </section>

      <section>
        <h3>Protomaps (PMTiles)</h3>
        <div className="param-stack">
          <label className="param wide">
            <span>PMTiles URL</span>
            <input id="map-pmtiles-url" type="url" placeholder="https://example.org/region.pmtiles" value={map.pmtilesUrl} onChange={e => updateMap({ pmtilesUrl: e.target.value })} />
          </label>
        </div>
        <div className="param-row">
          <label className="btn btn-small" htmlFor="map-pmtiles-file">
            Choose a .pmtiles file…
          </label>
          <input
            id="map-pmtiles-file"
            type="file"
            accept=".pmtiles"
            hidden
            onChange={async e => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              const kept = await setLocalPmtiles(f);
              notify(kept ? `${f.name} will be used for the Protomaps map, also after a reload.` : `${f.name} will be used until you close this tab (this browser could not store it).`, 'success');
            }}
          />
          {file && (
            <>
              <span className="muted">
                Local file: {file.name} ({(file.size / 1e6).toFixed(1)} MB)
              </span>
              <button type="button" className="link-btn" onClick={() => setLocalPmtiles(null)}>
                Remove
              </button>
            </>
          )}
        </div>
        <p className="field-hint">
          A local file is used first and works offline. Vector extracts (from maps.protomaps.com/builds or the pmtiles CLI) are drawn in a light or dark style following the theme; raster
          extracts are shown as they are. A URL must allow range requests and cross-origin access.
        </p>
        {!uses(id => id === 'protomaps') && <p className="field-hint">Select “Protomaps” as the base map or an overlay to see it.</p>}
      </section>

      <section>
        <h3>All maps and their terms</h3>
        {GROUPS.map(g => (
          <details key={g}>
            <summary>
              {g} ({MAPS.filter(m => m.group === g).length})
            </summary>
            <ul className="map-terms">
              {MAPS.filter(m => m.group === g).map(m => (
                <li key={m.id}>
                  <strong>{m.name}</strong>: {m.terms}{' '}
                  {m.termsUrl && (
                    <a href={m.termsUrl} target="_blank" rel="noreferrer">
                      Terms
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </details>
        ))}
      </section>
    </div>
  );
}
