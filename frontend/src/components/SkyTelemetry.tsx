// The telemetry panel's sky models: the Earth and Moon, the Earth around the Sun, and the solar system. Positions and
// every reading come from the server (services/sky.py: IAU SOFA/ERFA); physical facts from NASA's Planetary Fact
// Sheet (services/planet_facts.py). The pictures are views from above the ecliptic (north up, longitudes increasing
// anticlockwise); sizes and distances are not to scale. "Play" steps through positions the server computed.
import { useEffect, useMemo, useRef, useState } from 'react';
import { request } from '../lib/api';
import type { TelemetryView } from '../lib/prefs';

export const TELEMETRY_VIEWS: [TelemetryView, string][] = [
  ['earth', 'Earth: sun and time'],
  ['moon', 'Earth and Moon'],
  ['orbit', 'Earth around the Sun'],
  ['system', 'Solar system'],
];

type Facts = Record<string, Record<string, number | boolean | null>>;

interface Sky {
  at: string;
  earth: {
    rotationHours: number;
    spinSpeedKmh: number;
    axialTilt: number;
    distanceSunKm: number;
    distanceSunAu: number;
    orbitalSpeedKms: number;
    heliocentricLongitude: number;
    sunLongitude: number;
    lightMinutes: number;
    season: { north: string; south: string };
    events: { name: string; at: string }[];
    perihelion: { at: string; distanceKm: number };
    aphelion: { at: string; distanceKm: number };
    eraDegrees: number;
  };
  moon: {
    distanceKm: number;
    illuminationPct: number;
    elongation: number;
    phase: string;
    waxing: boolean;
    ageDays: number | null;
    lunationDays: number | null;
    events: { name: string; at: string }[];
    altitude: number;
    azimuth: number;
    rise: string | null;
    set: string | null;
    moonLongitude: number;
    sunLongitude: number;
  };
  planets: {
    name: string;
    distanceSunAu: number;
    orbitalSpeedKms: number;
    heliocentricLongitude: number;
    distanceEarthAu?: number;
    lightMinutes?: number;
    altitude?: number;
    azimuth?: number;
  }[];
  facts: Facts;
  factsSource: { name: string; url: string; read: string };
}

type TrackRow = Record<string, number | string>;

const SIZE = 200;
const RAD = Math.PI / 180;
const PLANET_COLOURS: Record<string, string> = {
  Mercury: '#b5b0a8',
  Venus: '#e8cf8a',
  Earth: '#4c9be8',
  Mars: '#d9603b',
  Jupiter: '#d8b48a',
  Saturn: '#e3d29c',
  Uranus: '#9fe0e8',
  Neptune: '#5b7fe8',
};

const num = (v: number, d = 0) => v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const when = (iso: string | null | undefined) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : '—');
const hms = (hours: number) => {
  const s = Math.round(hours * 3600);
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min ${s % 60} s`;
};
const compass = (az: number) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(az / 45) % 8];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Row({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="telemetry-row" title={title}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

/** Shortest-way interpolation of two longitudes (degrees). */
function lerpAngle(a: number, b: number, f: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return a + d * f;
}

function useSky(target: { lat: number; lon: number }) {
  const [sky, setSky] = useState<Sky | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      request<Sky>(`/api/live/sky?lat=${target.lat}&lon=${target.lon}`).then(
        s => {
          if (!live) return;
          setSky(s);
          setError(null);
        },
        e => live && setError(e instanceof Error ? e.message : 'Unavailable'),
      );
    load();
    const id = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [target.lat, target.lon]);
  return { sky, error };
}

function useTrack(model: 'moon' | 'orbit' | 'system') {
  const [track, setTrack] = useState<TrackRow[] | null>(null);
  useEffect(() => {
    let live = true;
    setTrack(null);
    request<{ track: TrackRow[] }>(`/api/live/sky/track?model=${model}`).then(
      r => live && setTrack(r.track),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [model]);
  return track;
}

/** Positions at a fractional index of the track (interpolated), or the live positions when idx is null. */
function at(track: TrackRow[] | null, idx: number | null) {
  if (!track || idx === null) return null;
  const i = Math.min(track.length - 2, Math.floor(idx));
  const f = idx - i;
  const a = track[i];
  const b = track[i + 1];
  const out: Record<string, number> = {};
  for (const k of Object.keys(a)) {
    if (k === 't') continue;
    out[k] = k === 'dist' ? Number(a[k]) + (Number(b[k]) - Number(a[k])) * f : lerpAngle(Number(a[k]), Number(b[k]), f);
  }
  return { values: out, t: String(f < 0.5 ? a.t : b.t) };
}

function setupCanvas(c: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== SIZE * dpr) {
    c.width = SIZE * dpr;
    c.height = SIZE * dpr;
  }
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, SIZE, SIZE);
  g.fillStyle = '#030814';
  g.beginPath();
  g.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 1, 0, 2 * Math.PI);
  g.fill();
  return g;
}

/** A disc lit from the direction `sunAngle` (radians, canvas angle): the day side bright, the night side dark. */
function litDisc(g: CanvasRenderingContext2D, x: number, y: number, r: number, sunAngle: number, day: string, night: string) {
  g.fillStyle = night;
  g.beginPath();
  g.arc(x, y, r, 0, 2 * Math.PI);
  g.fill();
  g.fillStyle = day;
  g.beginPath();
  g.arc(x, y, r, sunAngle - Math.PI / 2, sunAngle + Math.PI / 2);
  g.fill();
}

// Ecliptic longitude → canvas angle: longitude 0 to the right, increasing anticlockwise (canvas y points down).
const ang = (lonDeg: number) => -lonDeg * RAD;

function drawMoonModel(c: HTMLCanvasElement, moonLon: number, sunLon: number, spin: number) {
  const g = setupCanvas(c);
  const cx = SIZE / 2;
  const sunA = ang(sunLon);
  // Direction of the Sun.
  g.strokeStyle = 'rgba(255, 214, 10, 0.55)';
  g.setLineDash([3, 4]);
  g.beginPath();
  g.moveTo(cx, cx);
  g.lineTo(cx + Math.cos(sunA) * 92, cx + Math.sin(sunA) * 92);
  g.stroke();
  g.setLineDash([]);
  g.fillStyle = '#ffd60a';
  g.font = '10px sans-serif';
  g.fillText('☀ Sun', cx + Math.cos(sunA) * 70 - 14, cx + Math.sin(sunA) * 70 - 4);
  // The Moon's orbit (not to scale).
  g.strokeStyle = 'rgba(148, 163, 184, 0.35)';
  g.beginPath();
  g.arc(cx, cx, 72, 0, 2 * Math.PI);
  g.stroke();
  // The Earth, spinning: meridians turning anticlockwise seen from the north.
  litDisc(g, cx, cx, 20, sunA, '#3b82c4', '#0b2440');
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  for (let k = 0; k < 6; k++) {
    const a = spin + (k * Math.PI) / 3;
    g.beginPath();
    g.moveTo(cx, cx);
    g.lineTo(cx + Math.cos(-a) * 20, cx + Math.sin(-a) * 20);
    g.stroke();
  }
  // The Moon, lit on its sunward side.
  const mA = ang(moonLon);
  litDisc(g, cx + Math.cos(mA) * 72, cx + Math.sin(mA) * 72, 7, sunA, '#e5e7eb', '#1f2937');
}

function drawOrbitModel(c: HTMLCanvasElement, track: TrackRow[] | null, earthLon: number, tilt: number) {
  const g = setupCanvas(c);
  const cx = SIZE / 2;
  const R = 78;
  // The orbit from the computed track (eccentricity 0.017: nearly a circle; exaggerated ×5 so it can be seen).
  if (track && track.length > 2) {
    g.strokeStyle = 'rgba(148, 163, 184, 0.45)';
    g.beginPath();
    track.forEach((p, i) => {
      const r = R * (1 + (Number(p.dist) - 1) * 5);
      const a = ang(Number(p.lon));
      if (i) g.lineTo(cx + Math.cos(a) * r, cx + Math.sin(a) * r);
      else g.moveTo(cx + Math.cos(a) * r, cx + Math.sin(a) * r);
    });
    g.closePath();
    g.stroke();
  }
  // Season markers, inside the orbit: the Earth's heliocentric longitude at each (the Sun's longitude + 180°).
  g.fillStyle = 'rgba(203, 213, 225, 0.85)';
  g.font = '9px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const [lon, label] of [
    [180, 'Mar eq.'],
    [270, 'Jun sol.'],
    [0, 'Sep eq.'],
    [90, 'Dec sol.'],
  ] as [number, string][]) {
    const a = ang(lon);
    g.fillText(label, cx + Math.cos(a) * (R - 26), cx + Math.sin(a) * (R - 14));
  }
  g.textAlign = 'start';
  g.textBaseline = 'alphabetic';
  // The Sun.
  const grd = g.createRadialGradient(cx, cx, 2, cx, cx, 16);
  grd.addColorStop(0, '#fff7c2');
  grd.addColorStop(1, 'rgba(255, 196, 0, 0)');
  g.fillStyle = grd;
  g.beginPath();
  g.arc(cx, cx, 16, 0, 2 * Math.PI);
  g.fill();
  // The Earth, lit from the Sun, with its axis tilted (drawn in the plane of the picture, as a reminder of the tilt).
  const a = ang(earthLon);
  const ex = cx + Math.cos(a) * R;
  const ey = cx + Math.sin(a) * R;
  litDisc(g, ex, ey, 8, Math.atan2(cx - ey, cx - ex), '#4c9be8', '#0b2440');
  g.strokeStyle = '#e2e8f0';
  const t = tilt * RAD;
  g.beginPath();
  g.moveTo(ex - Math.sin(t) * 12, ey - Math.cos(t) * 12);
  g.lineTo(ex + Math.sin(t) * 12, ey + Math.cos(t) * 12);
  g.stroke();
}

function drawSystemModel(c: HTMLCanvasElement, lons: Record<string, number>, au: Record<string, number>) {
  const g = setupCanvas(c);
  const cx = SIZE / 2;
  // Distances on a square-root scale so the inner planets are not crowded (Neptune at the edge).
  const scale = (d: number) => 10 + (88 * Math.sqrt(d)) / Math.sqrt(30.5);
  g.fillStyle = '#ffd60a';
  g.beginPath();
  g.arc(cx, cx, 4.5, 0, 2 * Math.PI);
  g.fill();
  for (const name of Object.keys(PLANET_COLOURS)) {
    const r = scale(au[name] ?? 1);
    g.strokeStyle = 'rgba(148, 163, 184, 0.22)';
    g.beginPath();
    g.arc(cx, cx, r, 0, 2 * Math.PI);
    g.stroke();
    const a = ang(lons[name] ?? 0);
    g.fillStyle = PLANET_COLOURS[name];
    g.beginPath();
    g.arc(cx + Math.cos(a) * r, cx + Math.sin(a) * r, name === 'Jupiter' || name === 'Saturn' ? 3.6 : 2.8, 0, 2 * Math.PI);
    g.fill();
  }
}

export default function SkyTelemetry({ view, target }: { view: Exclude<TelemetryView, 'earth'>; target: { lat: number; lon: number; name: string } }) {
  const { sky, error } = useSky(target);
  const track = useTrack(view);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [playing, setPlaying] = useState(false);
  const [shownDate, setShownDate] = useState<string | null>(null);
  const idx = useRef<number | null>(null);
  const spin = useRef(0);

  // Time-lapse: the Moon a day a second, the Earth a month a second, the planets 3 months a second.
  const stepsPerSecond = view === 'moon' ? 4 : view === 'orbit' ? 15 : 3;
  useEffect(() => {
    setPlaying(false);
    idx.current = null;
    setShownDate(null);
  }, [view]);

  const au = useMemo(() => Object.fromEntries((sky?.planets ?? []).map(p => [p.name, p.distanceSunAu])), [sky]);

  // One drawing loop: live positions, or the time-lapse through the server's track; stops when the panel is hidden.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !sky) return;
    let raf = 0;
    let last = 0;
    let lastLabel = 0;
    const frame = (t: number) => {
      const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
      last = t;
      spin.current += dt * ((2 * Math.PI) / 8); // the Earth's spin shown at one turn every 8 s (it is really 23.93 h)
      if (playing && track) {
        const n = (idx.current ?? 0) + dt * stepsPerSecond;
        idx.current = n >= track.length - 1 ? 0 : n;
      }
      const sample = playing ? at(track, idx.current) : null;
      if (sample && t - lastLabel > 200) {
        lastLabel = t;
        setShownDate(sample.t.slice(0, 10));
      }
      const s = sample?.values;
      if (view === 'moon') drawMoonModel(c, s?.moon ?? sky.moon.moonLongitude, s?.sun ?? sky.moon.sunLongitude, spin.current);
      else if (view === 'orbit') drawOrbitModel(c, track, s?.lon ?? sky.earth.heliocentricLongitude, sky.earth.axialTilt);
      else drawSystemModel(c, s ?? Object.fromEntries(sky.planets.map(p => [p.name, p.heliocentricLongitude])), au);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [sky, track, playing, view, au, stepsPerSecond]);

  const dash = error ? 'Unavailable' : '…';
  const f = sky?.facts;
  const label = view === 'moon' ? 'Earth and Moon from above the North Pole' : view === 'orbit' ? "The Earth's orbit from above" : 'The planets around the Sun from above';
  return (
    <>
      <canvas ref={canvasRef} className="globe sky-model" style={{ width: SIZE, height: SIZE }} role="img" aria-label={label} id={`sky-${view}`} />
      <div className="globe-status">
        <span className="globe-status-text is-online" id="sky-when">
          {playing && shownDate ? `Time-lapse: ${shownDate}` : sky ? `Now · ${sky.at.slice(0, 16).replace('T', ' ')} UTC` : 'Loading…'}
        </span>
        <button
          type="button"
          className="globe-spin-toggle"
          id="sky-play"
          disabled={!track}
          onClick={() => {
            if (playing) {
              setPlaying(false);
              idx.current = null;
              setShownDate(null);
            } else {
              idx.current = 0;
              setPlaying(true);
            }
          }}
        >
          {playing ? 'Now' : view === 'moon' ? '▶ Month' : view === 'orbit' ? '▶ Year' : '▶ 12 years'}
        </button>
      </div>
      <p className="panel-foot">Seen from above the ecliptic; sizes and distances not to scale{view === 'moon' ? ", the Earth's spin speeded up" : ''}.</p>

      {view === 'moon' && (
        <>
          <div className="telemetry-section" id="sky-readings">
            <div className="eyebrow">Moon now</div>
            <Row label="Phase" value={sky ? `${sky.moon.phase}` : dash} />
            <Row label="Lit" value={sky ? `${num(sky.moon.illuminationPct, 1)} %` : dash} title="Illuminated fraction of the disc" />
            <Row label="Age" value={sky?.moon.ageDays != null ? `${num(sky.moon.ageDays, 1)} days` : dash} title="Days since the last new moon" />
            <Row label="Distance" value={sky ? `${num(sky.moon.distanceKm)} km` : dash} title="Centre of the Earth to centre of the Moon" />
            <Row label={`Altitude at ${target.name}`} value={sky ? `${num(sky.moon.altitude, 1)}° ${sky.moon.altitude < 0 ? '(below horizon)' : ''}` : dash} />
            <Row label="Azimuth" value={sky ? `${num(sky.moon.azimuth, 1)}° (${compass(sky.moon.azimuth)})` : dash} />
            <Row label="Next moonrise" value={sky ? when(sky.moon.rise) : dash} />
            <Row label="Next moonset" value={sky ? when(sky.moon.set) : dash} />
          </div>
          <div className="telemetry-section">
            <div className="eyebrow">Coming up</div>
            {sky?.moon.events.map(e => (
              <Row key={e.name} label={e.name} value={when(e.at)} />
            ))}
          </div>
          <div className="telemetry-section">
            <div className="eyebrow">Rotation and orbit</div>
            <Row label="Earth turns once in" value={sky ? hms(sky.earth.rotationHours) : dash} title="The stellar day: one turn relative to the stars (IAU Earth rotation rate)" />
            <Row label={`Spin speed at ${target.name}`} value={sky ? `${num(sky.earth.spinSpeedKmh)} km/h` : dash} />
            <Row label="Moon orbits Earth in" value={f ? `${f.Moon.orbitalPeriod} days` : dash} title="Sidereal month (NASA)" />
            <Row
              label="This lunation"
              value={sky?.moon.lunationDays != null ? `${num(sky.moon.lunationDays, 2)} days` : dash}
              title="Last new moon to the next (varies between about 29.3 and 29.8 days)"
            />
            <Row
              label="Moon turns once in"
              value={f ? `${f.Moon.rotationPeriod} h (${num(Number(f.Moon.rotationPeriod) / 24, 1)} days)` : dash}
              title="The same as its orbit: tidally locked, so it always shows the same face"
            />
          </div>
        </>
      )}

      {view === 'orbit' && sky && (
        <>
          <div className="telemetry-section" id="sky-readings">
            <div className="eyebrow">Earth now</div>
            <Row label="Distance from Sun" value={`${num(sky.earth.distanceSunKm / 1e6, 3)} million km`} />
            <Row label="" value={`${num(sky.earth.distanceSunAu, 5)} au · light ${num(sky.earth.lightMinutes, 2)} min`} />
            <Row label="Orbital speed" value={`${num(sky.earth.orbitalSpeedKms, 2)} km/s`} />
            <Row label="Axial tilt" value={`${num(sky.earth.axialTilt, 3)}°`} title="True obliquity of the ecliptic (IAU 2006 with nutation)" />
            <Row label="Season (north)" value={cap(sky.earth.season.north)} title="Astronomical season, by the Sun's position" />
            <Row label="Season (south)" value={cap(sky.earth.season.south)} />
          </div>
          <div className="telemetry-section">
            <div className="eyebrow">Coming up</div>
            {sky.earth.events.map(e => (
              <Row key={e.name} label={e.name} value={when(e.at)} />
            ))}
            <Row label="Perihelion (closest)" value={`${when(sky.earth.perihelion.at)} · ${num(sky.earth.perihelion.distanceKm / 1e6, 3)} M km`} />
            <Row label="Aphelion (farthest)" value={`${when(sky.earth.aphelion.at)} · ${num(sky.earth.aphelion.distanceKm / 1e6, 3)} M km`} />
          </div>
          <div className="telemetry-section">
            <div className="eyebrow">Orbit (NASA)</div>
            <Row label="Orbital period" value={`${f?.Earth.orbitalPeriod} days`} />
            <Row label="Eccentricity" value={`${f?.Earth.orbitalEccentricity}`} />
            <Row label="Turns once in" value={hms(sky.earth.rotationHours)} title="The stellar day (IAU)" />
          </div>
        </>
      )}

      {view === 'system' && sky && (
        <div className="telemetry-section" id="sky-readings">
          <div className="eyebrow">Planets now</div>
          {sky.planets.map(p => {
            const pf = f?.[p.name];
            const rot = Number(pf?.rotationPeriod);
            return (
              <details key={p.name} className="planet-row">
                <summary>
                  <i className="planet-dot" style={{ background: PLANET_COLOURS[p.name] }} /> {p.name}
                  <span className="planet-sum">
                    {num(p.distanceSunAu, 2)} au{p.altitude != null ? ` · ${p.altitude > 0 ? 'up' : 'set'}` : ''}
                  </span>
                </summary>
                <Row label="From the Sun" value={`${num(p.distanceSunAu, 3)} au (${num(p.distanceSunAu * 149.5978707, 1)} M km)`} />
                {p.distanceEarthAu != null && <Row label="From Earth" value={`${num(p.distanceEarthAu, 3)} au · light ${num(p.lightMinutes ?? 0, 1)} min`} />}
                {p.altitude != null && (
                  <Row label={`In the sky at ${target.name}`} value={`${num(p.altitude, 1)}°, ${compass(p.azimuth ?? 0)}${p.altitude < 0 ? ' (below horizon)' : ''}`} />
                )}
                <Row label="Orbital speed" value={`${num(p.orbitalSpeedKms, 1)} km/s`} />
                {pf && (
                  <>
                    <Row label="Year" value={`${num(Number(pf.orbitalPeriod), Number(pf.orbitalPeriod) < 1000 ? 1 : 0)} days`} />
                    <Row label="Turns once in" value={`${num(Math.abs(rot), 1)} h${rot < 0 ? ' (backwards)' : ''}`} title="Rotation period (NASA); backwards = retrograde" />
                    <Row label="Length of day" value={`${num(Number(pf.lengthOfDay), 1)} h`} title="Noon to noon (NASA)" />
                    <Row label="Axial tilt" value={`${pf.obliquity}°`} />
                    <Row label="Moons" value={`${pf.moons}`} />
                  </>
                )}
              </details>
            );
          })}
          {f?.Pluto && (
            <details className="planet-row">
              <summary>
                <i className="planet-dot" style={{ background: '#a8a29e' }} /> Pluto <span className="planet-sum">dwarf planet</span>
              </summary>
              <Row label="Year" value={`${num(Number(f.Pluto.orbitalPeriod))} days`} />
              <Row label="Turns once in" value={`${num(Math.abs(Number(f.Pluto.rotationPeriod)), 1)} h (backwards)`} />
              <Row label="Axial tilt" value={`${f.Pluto.obliquity}°`} />
              <Row label="Moons" value={`${f.Pluto.moons}`} />
              <p className="field-hint">Facts only: its position is not computed (the IAU routines cover the eight planets).</p>
            </details>
          )}
        </div>
      )}

      {sky && (
        <p className="panel-foot" id="sky-sources">
          Positions: IAU SOFA (ERFA). Facts:{' '}
          <a href={sky.factsSource.url} target="_blank" rel="noopener noreferrer">
            NASA Planetary Fact Sheet
          </a>
          .
        </p>
      )}
      {error && <p className="panel-foot">Sky data unavailable: {error}</p>}
    </>
  );
}
