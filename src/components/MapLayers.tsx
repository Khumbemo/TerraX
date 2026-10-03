import L from 'leaflet';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMap } from 'react-leaflet';
import { tileTemplates, type MapDef, type MapSettings } from '../lib/basemaps';
import { getLocalPmtiles, loadLocalPmtiles, onLocalPmtilesChange } from '../lib/pmtiles-store';

export type LayerStatus = { state: 'loading' | 'ok' | 'error'; message?: string };

interface Props {
  def: MapDef;
  settings: MapSettings;
  opacity: number;
  zIndex: number;
  dark: boolean;
  /** The base map (drawn under everything else). */
  base?: boolean;
  onStatus: (s: LayerStatus) => void;
}

/** Counts tile results and moves to the next URL template when the current one keeps failing. */
function watchTiles(layer: L.TileLayer, templates: string[], onStatus: (s: LayerStatus) => void, name: string) {
  let i = 0, ok = 0, bad = 0;
  const giveUpOnTemplate = () => {
    if (i + 1 < templates.length) {
      i++;
      ok = bad = 0;
      layer.setUrl(templates[i]);
    } else onStatus({ state: 'error', message: name });
  };
  layer.on('tileload', () => {
    ok++;
    onStatus({ state: 'ok' });
  });
  layer.on('tileerror', () => {
    bad++;
    if (ok === 0 && bad === 3) giveUpOnTemplate();
  });
  // 'load' fires once every visible tile has finished, so maps that need only one or two tiles are covered too.
  layer.on('load', () => {
    if (ok === 0 && bad > 0 && bad < 3) giveUpOnTemplate();
  });
}

/** Adds one map (raster, WMS, vector style or PMTiles) to the Leaflet map. */
export default function MapLayer({ def, settings, opacity, zIndex, dark, base = false, onStatus }: Props) {
  const map = useMap();
  const layerRef = useRef<L.Layer | null>(null);
  const opacityRef = useRef(opacity);
  opacityRef.current = opacity;
  const [fileVersion, setFileVersion] = useState(0);
  // Rebuild only when this map's own configuration changes (not when another layer's opacity moves).
  const config = useMemo(
    () =>
      JSON.stringify({
        t: def.kind === 'raster' ? tileTemplates(def, settings) : null,
        x: def.id === 'custom-xyz' ? settings.customXyz : null,
        w: def.kind === 'wms' ? settings.customWms : null,
        p: def.kind === 'pmtiles' ? settings.pmtilesUrl : null,
      }),
    [def, settings],
  );
  useEffect(() => onLocalPmtilesChange(() => setFileVersion(v => v + 1)), []);

  useEffect(() => {
    if (def.kind === 'none') return;
    let layer: L.Layer | null = null;
    let cancelled = false;
    onStatus({ state: 'loading' });
    const finish = (l: L.Layer) => {
      if (cancelled) return;
      layer = l;
      layerRef.current = l;
      l.addTo(map);
      applyOpacity(map, def, l, opacityRef.current);
    };
    const fail = (message: string) => !cancelled && onStatus({ state: 'error', message });

    if (def.kind === 'raster') {
      const templates = tileTemplates(def, settings);
      if (!templates.length) {
        fail(`${def.name} needs more settings (Settings → Map).`);
        return;
      }
      const t = L.tileLayer(templates[0], {
        subdomains: def.subdomains ?? 'abc',
        maxZoom: 22,
        maxNativeZoom: def.maxNativeZoom ?? def.maxZoom ?? (def.id === 'custom-xyz' ? settings.customXyz.maxZoom : 19),
        tileSize: def.tileSize ?? 256,
        zoomOffset: def.zoomOffset ?? 0,
        attribution: def.id === 'custom-xyz' ? settings.customXyz.attribution : def.attribution,
        opacity,
        zIndex,
      });
      watchTiles(t, templates, onStatus, def.name);
      finish(t);
    } else if (def.kind === 'wms') {
      const w = settings.customWms;
      if (!/^https?:\/\//i.test(w.url.trim()) || !w.layers.trim()) {
        fail('Enter the WMS address and layer name in Settings → Map.');
        return;
      }
      const t = L.tileLayer.wms(w.url.trim(), { layers: w.layers.trim(), format: w.format, transparent: true, version: '1.1.1', attribution: w.attribution, opacity, zIndex });
      watchTiles(t, [w.url.trim()], onStatus, 'Custom WMS');
      finish(t);
    } else if (def.kind === 'vector') {
      Promise.all([
        import('maplibre-gl'),
        import('@maplibre/maplibre-gl-leaflet'),
        import('maplibre-gl/dist/maplibre-gl.css'),
        // MapLibre looks for its worker next to its own chunk, where the bundler puts nothing; ship it as a worker of ours.
        import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'),
      ])
        .then(([maplibre, plugin, , worker]) => {
          if (cancelled) return;
          maplibre.setWorkerUrl(worker.default);
          const gl = plugin.maplibreGL({ style: def.style!, attribution: def.attribution, interactive: false } as never);
          finish(gl);
          const glMap = (gl as unknown as { getMaplibreMap: () => { on: (e: string, f: (ev: { error?: Error }) => void) => void; once: (e: string, f: () => void) => void } }).getMaplibreMap();
          glMap.on('error', ev => fail(`${def.name} did not load (${ev.error?.message ?? 'network error'}).`));
          glMap.once('load', () => !cancelled && onStatus({ state: 'ok' }));
          (gl as unknown as { getContainer: () => HTMLElement }).getContainer().style.zIndex = String(zIndex);
        })
        .catch(err => fail(`The vector map engine could not start: ${err instanceof Error ? err.message : String(err)}. It needs WebGL.`));
    } else if (def.kind === 'builtin') {
      import('./BuiltinLayers')
        .then(m => m.createBuiltinLayer(def, map, { opacity, zIndex, dark, base }))
        .then(l => {
          finish(l);
          if (!cancelled) onStatus({ state: 'ok' });
        })
        .catch(err => fail(`${def.name} could not be loaded (${err instanceof Error ? err.message : String(err)}).`));
    } else if (def.kind === 'pmtiles') {
      // protomaps-leaflet and pmtiles' raster layer extend the global Leaflet object.
      (window as unknown as { L?: typeof L }).L ??= L;
      Promise.all([import('protomaps-leaflet'), import('pmtiles'), loadLocalPmtiles()])
        .then(async ([pl, pm]) => {
          if (cancelled) return;
          const file = getLocalPmtiles();
          const url = settings.pmtilesUrl.trim();
          if (!file && !url) {
            fail('Choose a .pmtiles file or enter its URL in Settings → Map.');
            return;
          }
          const source = file ? new pm.PMTiles(new pm.FileSource(file)) : new pm.PMTiles(url);
          let tileType: number, minZoom = 0, maxZoom = 14;
          try {
            ({ tileType, minZoom, maxZoom } = await source.getHeader());
          } catch (err) {
            fail(`${file ? file.name : url} is not a readable PMTiles file (${err instanceof Error ? err.message : String(err)}).`);
            return;
          }
          if (cancelled) return;
          // Vector extracts are styled by protomaps-leaflet; raster extracts (PNG, JPEG, WebP) are shown as they are.
          const l =
            tileType === pm.TileType.Mvt
              ? (pl.leafletLayer({ url: source, flavor: dark ? 'dark' : 'light', lang: 'en', attribution: def.attribution, opacity, zIndex } as never) as unknown as L.Layer)
              : (pm.leafletRasterLayer(source, { attribution: def.attribution, opacity, zIndex, maxZoom: 22, minNativeZoom: minZoom, maxNativeZoom: maxZoom }) as unknown as L.Layer);
          finish(l);
          onStatus({ state: 'ok' });
        })
        .catch(err => fail(`Protomaps could not start: ${err instanceof Error ? err.message : String(err)}`));
    }
    return () => {
      cancelled = true;
      layerRef.current = null;
      if (layer) map.removeLayer(layer);
    };
    // `config` stands in for the settings this map uses; opacity is applied below without a rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, def, config, dark, zIndex, base, fileVersion]);

  useEffect(() => {
    if (layerRef.current) applyOpacity(map, def, layerRef.current, opacity);
  }, [map, def, opacity]);
  return null;
}

function applyOpacity(map: L.Map, def: MapDef, l: L.Layer, opacity: number) {
  const grid = l as L.GridLayer;
  if (typeof grid.setOpacity === 'function') grid.setOpacity(opacity);
  else if (def.kind === 'builtin') {
    const pane = map.getPane(`builtin-${def.id}`);
    if (pane) pane.style.opacity = String(opacity);
  }
  else {
    const gl = l as unknown as { getContainer?: () => HTMLElement };
    if (gl.getContainer) gl.getContainer().style.opacity = String(opacity);
  }
}
