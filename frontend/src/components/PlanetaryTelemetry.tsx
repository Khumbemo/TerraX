import { useEffect, useRef, useState } from 'react';
import { feature } from 'topojson-client';
import land from 'world-atlas/land-110m.json';
import type { MultiPolygon, Polygon } from 'geojson';
import { request } from '../lib/api';

interface Props {
  target: { lat: number; lon: number; name: string };
}

const RAD = Math.PI / 180;

/** Solar geometry and Kp from the TerraX server (services/solar.py, services/kp.py). */
interface Telemetry {
  solar: {
    at: string;
    meanSolarTime: number;
    apparentSolarTime: number;
    equationOfTime: number;
    declination: number;
    altitude: number;
    zenith: number;
    azimuth: number;
    sunrise: string | null;
    sunset: string | null;
    subsolar: { lat: number; lon: number };
  };
  kp: { reading: { kp: number; time: string; label: string } | null; error: string | null };
}

/** Formats hours-of-day (any real number) as HH:MM:SS, wrapping at 24 h. */
function formatClock(hours: number): string {
  const total = Math.round((((hours % 24) + 24) % 24) * 3600) % 86400;
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** Fetches telemetry once a minute; clocks and the subsolar longitude advance locally in between. */
function useTelemetry(target: { lat: number; lon: number }) {
  const [data, setData] = useState<{ t: Telemetry; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      request<Telemetry>(`/api/live/telemetry?lat=${target.lat}&lon=${target.lon}`)
        .then(t => {
          if (cancelled) return;
          setData({ t, at: Date.parse(t.solar.at) });
          setError(null);
        })
        .catch(err => !cancelled && setError(err instanceof Error ? err.message : 'Telemetry unavailable'));
    load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [target.lat, target.lon]);
  return { data, error };
}

function advance(t: Telemetry['solar'], fetchedAt: number, now: number) {
  const dh = (now - fetchedAt) / 3_600_000;
  return {
    ...t,
    meanSolarTime: t.meanSolarTime + dh,
    apparentSolarTime: t.apparentSolarTime + dh,
    subsolar: { lat: t.subsolar.lat, lon: ((((t.subsolar.lon - 15 * dh + 180) % 360) + 360) % 360) - 180 },
  };
}
const SIZE = 200;
const LAND = feature(land, land.objects.land) as unknown as { features: { geometry: Polygon | MultiPolygon }[] } | { geometry: Polygon | MultiPolygon };
const LAND_RINGS: number[][][] = (() => {
  const geoms = 'features' in LAND ? LAND.features.map(f => f.geometry) : [LAND.geometry];
  const rings: number[][][] = [];
  for (const g of geoms) {
    if (g.type === 'Polygon') rings.push(...g.coordinates);
    else for (const poly of g.coordinates) rings.push(...poly);
  }
  return rings;
})();

/** Per-pixel geometry for one canvas size and view latitude (independent of the view longitude). */
interface GlobeGeometry {
  px: number;
  lat0: number;
  /** Pixel index inside the disc, sin/cos of latitude and longitude offset from the view centre. */
  idx: Int32Array;
  sinPhi: Float32Array;
  cosPhi: Float32Array;
  dLam: Float32Array;
}

function globeGeometry(px: number, lat0: number): GlobeGeometry {
  const R = px / 2 - 2 * (px / SIZE);
  const c0 = px / 2;
  const sinP0 = Math.sin(lat0 * RAD), cosP0 = Math.cos(lat0 * RAD);
  const idx: number[] = [], sp: number[] = [], cp: number[] = [], dl: number[] = [];
  for (let y = 0; y < px; y++)
    for (let x = 0; x < px; x++) {
      const dx = (x - c0) / R, dy = (c0 - y) / R;
      const rho = Math.hypot(dx, dy);
      if (rho > 1) continue;
      const c = Math.asin(rho), sinc = Math.sin(c), cosc = Math.cos(c);
      const phi = rho === 0 ? lat0 * RAD : Math.asin(cosc * sinP0 + (dy * sinc * cosP0) / rho);
      idx.push(y * px + x);
      sp.push(Math.sin(phi));
      cp.push(Math.cos(phi));
      dl.push(rho === 0 ? 0 : Math.atan2(dx * sinc, rho * cosc * cosP0 - dy * sinc * sinP0));
    }
  return { px, lat0, idx: Int32Array.from(idx), sinPhi: Float32Array.from(sp), cosPhi: Float32Array.from(cp), dLam: Float32Array.from(dl) };
}

let geomCache: GlobeGeometry | null = null;

function drawGlobe(canvas: HTMLCanvasElement, lat0: number, lon0: number, sub: { lat: number; lon: number }, target: { lat: number; lon: number }) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const px = Math.round(SIZE * dpr);
  if (canvas.width !== px) {
    canvas.width = px;
    canvas.height = px;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (!geomCache || geomCache.px !== px || geomCache.lat0 !== lat0) geomCache = globeGeometry(px, lat0);
  const g = geomCache;
  const R = px / 2 - 2 * dpr;
  const cx = px / 2;
  const cy = px / 2;
  const phi0 = lat0 * RAD;
  const lam0 = lon0 * RAD;
  const sinP0 = Math.sin(phi0);
  const cosP0 = Math.cos(phi0);

  const project = (lon: number, lat: number): [number, number] | null => {
    const phi = lat * RAD;
    const dl = lon * RAD - lam0;
    const cosc = sinP0 * Math.sin(phi) + cosP0 * Math.cos(phi) * Math.cos(dl);
    if (cosc < 0) return null;
    return [cx + R * Math.cos(phi) * Math.sin(dl), cy - R * (cosP0 * Math.sin(phi) - sinP0 * Math.cos(phi) * Math.cos(dl))];
  };

  // Ocean disc with day/night shading: one cosine per pixel using the cached geometry.
  const img = ctx.createImageData(px, px);
  const sinD = Math.sin(sub.lat * RAD);
  const cosD = Math.cos(sub.lat * RAD);
  const off = lam0 - sub.lon * RAD;
  for (let i = 0; i < g.idx.length; i++) {
    const sunCos = g.sinPhi[i] * sinD + g.cosPhi[i] * cosD * Math.cos(g.dLam[i] + off);
    const light = Math.max(0, Math.min(1, (sunCos + 0.1) / 0.2)); // soft twilight band
    const o = g.idx[i] * 4;
    img.data[o] = 6 + 10 * light;
    img.data[o + 1] = 18 + 30 * light;
    img.data[o + 2] = 34 + 50 * light;
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  // Graticule every 30°
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.14)';
  ctx.lineWidth = dpr * 0.8;
  const line = (pts: [number, number][]) => {
    ctx.beginPath();
    let pen = false;
    for (const [lon, lat] of pts) {
      const p = project(lon, lat);
      if (!p) {
        pen = false;
        continue;
      }
      if (pen) ctx.lineTo(p[0], p[1]);
      else ctx.moveTo(p[0], p[1]);
      pen = true;
    }
    ctx.stroke();
  };
  for (let lon = -180; lon < 180; lon += 30) line(Array.from({ length: 61 }, (_, i) => [lon, -90 + i * 3] as [number, number]));
  for (let lat = -60; lat <= 60; lat += 30) line(Array.from({ length: 121 }, (_, i) => [-180 + i * 3, lat] as [number, number]));

  // Coastlines
  ctx.strokeStyle = 'rgba(148, 197, 230, 0.75)';
  ctx.lineWidth = dpr;
  for (const ring of LAND_RINGS) line(ring as [number, number][]);

  // Rim
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.stroke();

  // Subsolar point and target
  const s = project(sub.lon, sub.lat);
  if (s) {
    ctx.fillStyle = '#f5b84b';
    ctx.beginPath();
    ctx.arc(s[0], s[1], 3.5 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = project(target.lon, target.lat);
  if (t) {
    ctx.strokeStyle = '#34d399';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.arc(t[0], t[1], 5 * dpr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#34d399';
    ctx.beginPath();
    ctx.arc(t[0], t[1], 1.8 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** One full turn every 40 s while spinning. */
const SPIN_DEG_PER_S = 9;

/** True while the browser reports a network connection. */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

const Row = ({ label, value, title }: { label: string; value: string; title?: string }) => (
  <div className="telemetry-row" title={title}>
    <span className="telemetry-label">{label}</span>
    <span className="telemetry-value">{value}</span>
  </div>
);

const utcClock = (d: Date | null) => (d ? `${d.toISOString().slice(11, 16)} UTC` : '—');

export default function PlanetaryTelemetry({ target }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [now, setNow] = useState(() => new Date());
  const { data: tele, error: teleError } = useTelemetry(target);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const report = tele ? advance(tele.t.solar, tele.at, now.getTime()) : null;
  const subsolarRef = useRef<{ lat: number; lon: number } | null>(null);
  subsolarRef.current = report?.subsolar ?? null;
  const minuteKey = Math.floor(now.getTime() / 60_000);

  const online = useOnline();
  const [paused, setPaused] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const spinning = online && !paused;
  const lat0 = Math.max(-60, Math.min(60, target.lat));
  const lonRef = useRef(target.lon);

  // Static view (offline or paused): face the target, redraw once a minute as the terminator moves ~0.25°/min.
  useEffect(() => {
    if (spinning || !canvasRef.current || !subsolarRef.current) return;
    lonRef.current = target.lon;
    drawGlobe(canvasRef.current, lat0, target.lon, subsolarRef.current, target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinning, minuteKey, lat0, target.lat, target.lon, Boolean(tele)]);

  // Spinning view while online: the globe turns eastward; drawing stops when it is off-screen or the tab is hidden.
  useEffect(() => {
    const c = canvasRef.current;
    if (!spinning || !c) return;
    let raf = 0, visible = true, lastDraw = 0;
    const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(([e]) => (visible = e.isIntersecting)) : null;
    io?.observe(c);
    const frame = (t: number) => {
      // ~30 frames per second is smooth for a slow spin and keeps CPU use low; rAF itself stops in hidden tabs.
      if (visible && t - lastDraw > 33) {
        const dt = lastDraw ? Math.min(0.1, (t - lastDraw) / 1000) : 0;
        lastDraw = t;
        // The Earth turns west to east, so surface features drift left to right: the view longitude decreases.
        lonRef.current = ((lonRef.current - SPIN_DEG_PER_S * dt + 540) % 360) - 180;
        if (subsolarRef.current) drawGlobe(c, lat0, lonRef.current, subsolarRef.current, target);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      io?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinning, lat0, target.lat, target.lon]);

  const eot = report?.equationOfTime ?? 0;
  const sunrise = report?.sunrise ? new Date(report.sunrise) : null;
  const sunset = report?.sunset ? new Date(report.sunset) : null;
  const dayLength = sunrise && sunset ? (sunset.getTime() - sunrise.getTime()) / 3_600_000 : null;
  const dash = teleError ? 'Unavailable' : '…';
  const kp = tele?.t.kp;

  return (
    <div className="telemetry-panel-inner">
      <div className="panel-header">
        <span className="pulse-dot" aria-hidden="true" /> Planetary telemetry
      </div>

      <canvas
        ref={canvasRef}
        className="globe"
        data-spinning={spinning ? 'true' : 'false'}
        style={{ width: SIZE, height: SIZE }}
        role="img"
        aria-label={spinning ? 'Rotating globe showing day and night' : `Globe centred on ${target.name} showing day and night`}
      />
      <div className="globe-status">
        <span className={`globe-status-text ${online ? 'is-online' : 'is-offline'}`}>
          {!online ? 'Offline · globe paused on target' : spinning ? 'Online · rotating (1 turn / 40 s)' : 'Online · rotation paused'}
        </span>
        {online && (
          <button type="button" className="globe-spin-toggle" onClick={() => setPaused((v) => !v)} aria-pressed={!paused}>
            {paused ? 'Rotate' : 'Pause'}
          </button>
        )}
      </div>
      <div className="globe-legend">
        <span>
          <i className="dot dot-target" /> {target.name}
        </span>
        <span>
          <i className="dot dot-sun" /> Sun overhead
        </span>
      </div>

      <div className="telemetry-section">
        <div className="eyebrow">Time</div>
        <Row label="UTC" value={now.toISOString().slice(11, 19)} />
        <Row label="Mean solar time" value={report ? formatClock(report.meanSolarTime) : dash} title="UTC + longitude / 15" />
        <Row label="Apparent solar time" value={report ? formatClock(report.apparentSolarTime) : dash} title="Sundial time: mean solar time + equation of time" />
        <Row label="Equation of time" value={report ? `${eot >= 0 ? '+' : '−'}${Math.abs(eot).toFixed(1)} min` : dash} />
      </div>

      <div className="telemetry-section">
        <div className="eyebrow">Sun at target</div>
        <Row label="Altitude" value={report ? `${report.altitude.toFixed(2)}°` : dash} title="Updated every minute" />
        <Row label="Zenith angle" value={report ? `${report.zenith.toFixed(2)}°` : dash} />
        <Row label="Azimuth (true N)" value={report ? `${report.azimuth.toFixed(2)}°` : dash} />
        <Row label="Declination" value={report ? `${report.declination.toFixed(2)}°` : dash} />
        <Row label="Sunrise" value={report ? utcClock(sunrise) : dash} />
        <Row label="Sunset" value={report ? utcClock(sunset) : dash} />
        <Row label="Day length" value={dayLength !== null ? `${Math.floor(Math.round(dayLength * 60) / 60)} h ${Math.round(dayLength * 60) % 60} min` : '—'} />
      </div>

      <div className="telemetry-section">
        <div className="eyebrow">Space weather (NOAA SWPC)</div>
        <Row label="Planetary Kp" value={!kp ? (teleError ? 'Unavailable (server not reachable)' : 'Loading…') : kp.reading ? `${kp.reading.kp.toFixed(2)} · ${kp.reading.label}` : (kp.error ?? '—')} />
        {kp?.reading && <Row label="Interval start" value={`${kp.reading.time.slice(0, 16).replace('T', ' ')} UTC`} />}
      </div>
      <p className="panel-foot">
        Target {Math.abs(target.lat).toFixed(3)}° {target.lat >= 0 ? 'N' : 'S'}, {Math.abs(target.lon).toFixed(3)}° {target.lon >= 0 ? 'E' : 'W'} · change in Settings
      </p>
    </div>
  );
}
