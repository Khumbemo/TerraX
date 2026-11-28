import { useEffect, useMemo, useRef, useState } from 'react';
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon } from 'geojson';
import { request } from '../lib/api';

/** A search result: where to fly, and whether to open the place card there. */
export interface PlaceHit {
  name: string;
  detail: string;
  lat: number;
  lon: number;
  zoom: number;
  kind: 'coords' | 'place' | 'country';
}

interface Props {
  onSelect: (hit: PlaceHit) => void;
}

/** Natural Earth populated place: name, lat, lon, min zoom, population, rank (served by /api/maps/vector/places). */
type PlaceRow = [string, number, number, number, number, number];

interface Index {
  places: { name: string; key: string; lat: number; lon: number; pop: number }[];
  countries: { name: string; key: string; lat: number; lon: number }[];
  /** Country containing a point (Natural Earth 1:50m), or null at sea. */
  countryAt: (lat: number, lon: number) => string | null;
}

let indexPromise: Promise<Index> | null = null;
function loadIndex(): Promise<Index> {
  if (!indexPromise)
    indexPromise = Promise.all([
      request<PlaceRow[]>('/api/maps/vector/places').catch(() => [] as PlaceRow[]),
      Promise.all([import('world-atlas/countries-50m.json'), import('topojson-client'), import('d3-geo')]),
    ]).then(([rows, [topo, { feature }, { geoArea, geoCentroid, geoContains }]]) => {
      const t = topo.default as unknown as Parameters<typeof feature>[0] & { objects: { countries: never } };
      const fc = feature(t, t.objects.countries) as unknown as FeatureCollection<Geometry, { name?: string }>;
      // A country's main landmass: its largest polygon, so the view does not land between, say, Alaska and Hawaii.
      const main = (g: Geometry): Feature<Polygon> | Feature<MultiPolygon> => {
        if (g.type !== 'MultiPolygon') return { type: 'Feature', properties: {}, geometry: g as Polygon };
        const polys = g.coordinates.map(c => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: c } }) as Feature<Polygon>);
        return polys.reduce((a, b) => (geoArea(b) > geoArea(a) ? b : a));
      };
      const cache = new Map<string, string | null>();
      const countryAt = (lat: number, lon: number) => {
        const k = `${lat},${lon}`;
        if (!cache.has(k)) cache.set(k, fc.features.find(f => f.geometry && geoContains(f, [lon, lat]))?.properties?.name ?? null);
        return cache.get(k)!;
      };
      return {
        countryAt,
        places: rows.map(r => ({ name: r[0], key: fold(r[0]), lat: r[1], lon: r[2], pop: r[4] })),
        countries: fc.features
          .filter(f => f.properties?.name && f.geometry)
          .map(f => {
            const [lon, lat] = geoCentroid(main(f.geometry));
            return { name: f.properties!.name!, key: fold(f.properties!.name!), lat, lon };
          }),
      };
    });
  return indexPromise;
}

/** Lower case without accents, so "sao paulo" finds "São Paulo". */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/**
 * Coordinates typed as decimal degrees ("25.674, 94.108", "-33.9 18.4") or degrees–minutes–seconds with hemisphere
 * letters ("25°40'26"N 94°6'29"E", "33 55 S 18 25 E"). Returns [lat, lon] or null.
 */
export function parseCoords(text: string): [number, number] | null {
  const s = text.trim().replace(/[′’']/g, "'").replace(/[″”"]/g, '"');
  const dec = s.match(/^([-+]?\d+(?:\.\d+)?)\s*[,;\s]\s*([-+]?\d+(?:\.\d+)?)$/);
  if (dec) {
    const lat = Number(dec[1]),
      lon = Number(dec[2]);
    return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
  }
  const part = String.raw`(\d+(?:\.\d+)?)\s*°?\s*(?:(\d+(?:\.\d+)?)\s*'?\s*)?(?:(\d+(?:\.\d+)?)\s*"?\s*)?([NSEW])`;
  const m = s.toUpperCase().match(new RegExp(`^${part}\\s*[,;]?\\s*${part}$`));
  if (!m) return null;
  const val = (d: string, mi?: string, se?: string) => Number(d) + Number(mi ?? 0) / 60 + Number(se ?? 0) / 3600;
  const a = { v: val(m[1], m[2], m[3]), h: m[4] },
    b = { v: val(m[5], m[6], m[7]), h: m[8] };
  if (Number(m[2] ?? 0) >= 60 || Number(m[3] ?? 0) >= 60 || Number(m[6] ?? 0) >= 60 || Number(m[7] ?? 0) >= 60) return null;
  const latP = 'NS'.includes(a.h) ? a : b,
    lonP = latP === a ? b : a;
  if (!'NS'.includes(latP.h) || !'EW'.includes(lonP.h)) return null;
  const lat = latP.h === 'S' ? -latP.v : latP.v,
    lon = lonP.h === 'W' ? -lonP.v : lonP.v;
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
}

/** Up to `limit` matches: names starting with the text first (bigger places first), then names containing it. */
export function searchIndex(index: Index, text: string, limit = 8): PlaceHit[] {
  const q = fold(text);
  if (q.length < 2) return [];
  const countries = index.countries.filter(c => c.key.startsWith(q) || (q.length >= 3 && c.key.includes(q)));
  const starts = index.places.filter(p => p.key.startsWith(q));
  const contains = q.length >= 3 ? index.places.filter(p => !p.key.startsWith(q) && p.key.includes(q)) : [];
  const byPop = (a: { pop: number }, b: { pop: number }) => b.pop - a.pop;
  const shownCountries = countries.slice(0, 3);
  return [
    ...shownCountries.map(c => ({ name: c.name, detail: 'Country', lat: c.lat, lon: c.lon, zoom: 4, kind: 'country' as const })),
    ...[...starts.sort(byPop), ...contains.sort(byPop)].slice(0, limit - shownCountries.length).map(p => ({
      name: p.name,
      detail: [index.countryAt(p.lat, p.lon), p.pop ? `${p.pop.toLocaleString('en')} people` : null].filter(Boolean).join(' · ') || 'Place',
      lat: p.lat,
      lon: p.lon,
      zoom: 10,
      kind: 'place' as const,
    })),
  ];
}

/** Search box over the map: place names (Natural Earth, offline), countries, or typed coordinates. */
export default function PlaceSearch({ onSelect }: Props) {
  const [text, setText] = useState('');
  const [index, setIndex] = useState<Index | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && !index)
      loadIndex()
        .then(setIndex)
        .catch(() => undefined);
  }, [open, index]);

  useEffect(() => {
    const away = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);

  const hits = useMemo((): PlaceHit[] => {
    const c = parseCoords(text);
    if (c) return [{ name: `${c[0].toFixed(5)}°, ${c[1].toFixed(5)}°`, detail: 'Coordinates', lat: c[0], lon: c[1], zoom: 11, kind: 'coords' }];
    return index ? searchIndex(index, text) : [];
  }, [text, index]);

  const choose = (h: PlaceHit) => {
    onSelect(h);
    setText(h.kind === 'coords' ? text : h.name);
    setOpen(false);
  };

  return (
    <div className="place-search" ref={box}>
      <input
        id="place-search"
        type="search"
        placeholder="Search a place, country or coordinates"
        aria-label="Search a place, country or coordinates"
        autoComplete="off"
        value={text}
        role="combobox"
        aria-expanded={open && hits.length > 0}
        aria-controls="place-search-list"
        onFocus={() => setOpen(true)}
        onChange={e => {
          setText(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') setActive(a => Math.min(a + 1, hits.length - 1));
          else if (e.key === 'ArrowUp') setActive(a => Math.max(a - 1, 0));
          else if (e.key === 'Enter' && hits[active]) choose(hits[active]);
          else if (e.key === 'Escape') {
            // Close only the list: the place card (which also listens for Escape) stays open.
            e.stopPropagation();
            setOpen(false);
          } else return;
          e.preventDefault();
        }}
      />
      {open && text.trim().length >= 2 && (
        <ul id="place-search-list" role="listbox" className="place-search-list">
          {hits.length === 0 ? (
            <li className="muted">{index ? 'No match among the 7,300 bundled places and countries. Try coordinates such as 25.67, 94.11.' : 'Loading places…'}</li>
          ) : (
            hits.map((h, i) => (
              <li key={`${h.kind}:${h.name}:${h.lat}`} role="option" aria-selected={i === active}>
                <button type="button" className={i === active ? 'active' : ''} onMouseEnter={() => setActive(i)} onClick={() => choose(h)}>
                  <span>{h.name}</span>
                  <span className="muted">{h.detail}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
