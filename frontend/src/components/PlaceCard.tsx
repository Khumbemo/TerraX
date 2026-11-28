import { useEffect, useState } from 'react';
import type { FeatureCollection, Geometry } from 'geojson';
import { request } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { elevationM, lengthM } from '../lib/units';

/** What the server knows about a point (services/place.py). */
export interface PlaceInfo {
  lat: number;
  lon: number;
  dms: string;
  utm: { zone: number; hemisphere: 'N' | 'S'; easting: number; northing: number; label: string } | null;
  nearest: { name: string; lat: number; lon: number; population: number | null; distanceKm: number; bearing: number; direction: string | null }[];
  koppen: { code: string; name: string; color: string } | null;
  biome: { name: string; color: string } | null;
  sun: { date: string; sunrise: string | null; sunset: string | null; dayLengthMin: number | null; polar: 'day' | 'night' | null; altitudeNow: number; azimuthNow: number };
  sources: Record<string, string>;
}

interface Props {
  at: { lat: number; lon: number };
  onClose: () => void;
  onWeather: (lat: number, lon: number, name: string) => void;
  onSatellite: (lat: number, lon: number, name: string) => void;
  onTarget: (lat: number, lon: number, name: string) => void;
  onBoundary: (lat: number, lon: number) => void;
}

// Natural Earth 1:50m countries (world-atlas, public domain), loaded once, for the country name at a point.
let countriesPromise: Promise<{ features: { name: string; geometry: Geometry }[]; contains: (g: Geometry, p: [number, number]) => boolean }> | null = null;
function countries() {
  if (!countriesPromise)
    countriesPromise = Promise.all([import('world-atlas/countries-50m.json'), import('topojson-client'), import('d3-geo')]).then(([topo, { feature }, { geoContains }]) => {
      const t = topo.default as unknown as Parameters<typeof feature>[0] & { objects: { countries: never } };
      const fc = feature(t, t.objects.countries) as unknown as FeatureCollection<Geometry, { name?: string }>;
      return {
        features: fc.features.map(f => ({ name: f.properties?.name ?? '', geometry: f.geometry })),
        contains: (g: Geometry, p: [number, number]) => geoContains(g, p),
      };
    });
  return countriesPromise;
}

const hhmm = (iso: string | null) => (iso ? `${iso.slice(11, 16)} UTC` : '—');

/** The card shown where the map was clicked: coordinates, nearest places, climate zone, biome, the sun, and what to do here. */
export default function PlaceCard({ at, onClose, onWeather, onSatellite, onTarget, onBoundary }: Props) {
  const { units } = usePrefs();
  const [info, setInfo] = useState<PlaceInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [country, setCountry] = useState<string | null | undefined>(undefined);
  // Ground height comes from an outside service (Open-Meteo), so it loads on its own and the card never waits for it.
  const [elev, setElev] = useState<{ value: number | null; error?: string } | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    setInfo(null);
    setError(null);
    setCountry(undefined);
    setElev(undefined);
    request<{ elevation: number | null }>(`/api/live/earth/elevation?lat=${at.lat.toFixed(5)}&lon=${at.lon.toFixed(5)}`)
      .then(r => alive && setElev({ value: r.elevation }))
      .catch(err => alive && setElev({ value: null, error: err instanceof Error ? err.message : 'unavailable' }));
    request<PlaceInfo>(`/api/maps/place?lat=${at.lat.toFixed(5)}&lon=${at.lon.toFixed(5)}`)
      .then(r => alive && setInfo(r))
      .catch(err => alive && setError(err instanceof Error ? err.message : 'Could not read this place.'));
    countries()
      .then(c => alive && setCountry(c.features.find(f => c.contains(f.geometry, [at.lon, at.lat]))?.name ?? null))
      .catch(() => alive && setCountry(null));
    return () => {
      alive = false;
    };
  }, [at.lat, at.lon]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const near = info?.nearest[0];
  const name = near && near.distanceKm < 15 ? near.name : `${at.lat.toFixed(3)}°, ${at.lon.toFixed(3)}°`;
  const placeLine = (n: PlaceInfo['nearest'][number]) =>
    n.distanceKm < 0.5 ? `In ${n.name}` : `${lengthM(n.distanceKm * 1000, units)} ${n.direction ?? ''} of ${n.name}`.replace(/\s+/g, ' ');
  const copy = (text: string) => navigator.clipboard?.writeText(text).catch(() => undefined);

  return (
    <section className="place-card" role="dialog" aria-label="Place" data-testid="place-card">
      <header className="place-head">
        <div>
          <div className="eyebrow">{country === undefined ? 'This place' : (country ?? 'Open sea or no country')}</div>
          <h3 id="place-name">{name}</h3>
        </div>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </header>
      {error && <p className="notice notice-error">{error}</p>}
      {!info && !error && <p className="muted">Reading this place…</p>}
      {info && (
        <>
          <dl className="place-facts">
            <div className="place-fact">
              <dt>Coordinates</dt>
              <dd>
                <button type="button" className="link-btn num" title="Copy" onClick={() => copy(`${info.lat.toFixed(5)}, ${info.lon.toFixed(5)}`)}>
                  {info.lat.toFixed(5)}°, {info.lon.toFixed(5)}°
                </button>
                <div className="muted num">{info.dms}</div>
                {info.utm && <div className="muted num">UTM {info.utm.label}</div>}
              </dd>
            </div>
            <div className="place-fact">
              <dt>Elevation</dt>
              <dd id="place-elevation">
                {elev === undefined ? (
                  <span className="muted">Reading…</span>
                ) : elev.error ? (
                  <span className="muted">Not available ({elev.error})</span>
                ) : (
                  <>
                    <span className="num">{elevationM(elev.value, units)}</span>
                    {elev.value === 0 && <div className="muted">0 is also what the model gives over the sea.</div>}
                  </>
                )}
              </dd>
            </div>
            <div className="place-fact">
              <dt>Nearest place</dt>
              <dd id="place-nearest">
                {info.nearest.slice(0, 2).map(n => (
                  <div key={n.name + n.lat}>{placeLine(n)}</div>
                ))}
              </dd>
            </div>
            <div className="place-fact">
              <dt>Climate zone</dt>
              <dd id="place-koppen">
                {info.koppen ? (
                  <>
                    <i className="class-swatch" style={{ background: info.koppen.color }} /> {info.koppen.code} · {info.koppen.name}
                  </>
                ) : (
                  'None (sea or no data)'
                )}
              </dd>
            </div>
            <div className="place-fact">
              <dt>Biome</dt>
              <dd id="place-biome">
                {info.biome ? (
                  <>
                    <i className="class-swatch" style={{ background: info.biome.color }} /> {info.biome.name}
                  </>
                ) : (
                  'None (sea or no data)'
                )}
              </dd>
            </div>
            <div className="place-fact">
              <dt>Sun today</dt>
              <dd id="place-sun">
                {info.sun.polar === 'day'
                  ? 'Polar day: the sun does not set'
                  : info.sun.polar === 'night'
                    ? 'Polar night: the sun does not rise'
                    : `Rises ${hhmm(info.sun.sunrise)}, sets ${hhmm(info.sun.sunset)}`}
                {info.sun.dayLengthMin != null && (
                  <div className="muted">
                    Day length {Math.floor(info.sun.dayLengthMin / 60)} h {info.sun.dayLengthMin % 60} min · sun now {info.sun.altitudeNow.toFixed(1)}°{' '}
                    {info.sun.altitudeNow < 0 ? '(below the horizon)' : 'up'}
                  </div>
                )}
              </dd>
            </div>
          </dl>
          <div className="place-actions">
            <button type="button" id="place-weather" className="btn btn-small" onClick={() => onWeather(info.lat, info.lon, name)}>
              Weather history here
            </button>
            <button type="button" id="place-satellite" className="btn btn-small" onClick={() => onSatellite(info.lat, info.lon, name)}>
              Satellite images here
            </button>
            <button type="button" id="place-boundary" className="btn btn-small" onClick={() => onBoundary(info.lat, info.lon)}>
              Draw a boundary from here
            </button>
            <button type="button" id="place-target" className="btn btn-small" onClick={() => onTarget(info.lat, info.lon, name)}>
              Set as telemetry target
            </button>
          </div>
          <p className="field-hint place-sources">
            Places: Natural Earth (public domain). Climate: Beck et al. 2018. Biome: RESOLVE 2017. Both maps are at about 10 km, so near a boundary the class can differ from the
            ground. Sun times: NOAA solar equations, in UTC. Elevation: Copernicus DEM GLO-90 (90 m) of the EU Copernicus programme,{' '}
            <a href="https://doi.org/10.5270/ESA-c5d3d65" target="_blank" rel="noopener noreferrer">
              doi:10.5270/ESA-c5d3d65
            </a>
            , through{' '}
            <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">
              Open-Meteo
            </a>
            .
          </p>
        </>
      )}
    </section>
  );
}
