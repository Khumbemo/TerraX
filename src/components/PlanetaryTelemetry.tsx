import { useEffect, useRef, useState } from 'react';
import { feature } from 'topojson-client';
import land from 'world-atlas/land-110m.json';
import type { MultiPolygon, Polygon } from 'geojson';
import { describeKp, fetchKp, type KpReading } from '../lib/kp';
import { formatClock, solarReport } from '../lib/solar';

interface Props {
  target: { lat: number; lon: number; name: string };
}

const RAD = Math.PI / 180;
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

function drawGlobe(canvas: HTMLCanvasElement, lat0: number, lon0: number, sub: { lat: number; lon: number }) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const px = SIZE * dpr;
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
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

  // Ocean disc with day/night shading (per-pixel inverse orthographic).
  const img = ctx.createImageData(px, px);
  const sinD = Math.sin(sub.lat * RAD);
  const cosD = Math.cos(sub.lat * RAD);
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const dx = (x - cx) / R;
      const dy = (cy - y) / R;
      const rho = Math.hypot(dx, dy);
      if (rho > 1) continue;
      const c = Math.asin(rho);
      const sinc = Math.sin(c);
      const cosc = Math.cos(c);
      const phi = rho === 0 ? phi0 : Math.asin(cosc * sinP0 + (dy * sinc * cosP0) / rho);
      const lam = lam0 + Math.atan2(dx * sinc, rho * cosc * cosP0 - dy * sinc * sinP0);
      const sunCos = Math.sin(phi) * sinD + Math.cos(phi) * cosD * Math.cos(lam - sub.lon * RAD);
      const light = Math.max(0, Math.min(1, (sunCos + 0.1) / 0.2)); // soft twilight band
      const o = (y * px + x) * 4;
      img.data[o] = 6 + 10 * light;
      img.data[o + 1] = 18 + 30 * light;
      img.data[o + 2] = 34 + 50 * light;
      img.data[o + 3] = 255;
    }
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
  const t = project(lon0, lat0);
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
  const [kp, setKp] = useState<{ reading: KpReading | null; error: string | null; loading: boolean }>({ reading: null, error: null, loading: true });

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const report = solarReport(now, target.lat, target.lon);
  const minuteKey = Math.floor(now.getTime() / 60_000);

  // Redraw the globe once a minute (the terminator moves ~0.25° per minute).
  useEffect(() => {
    if (canvasRef.current) drawGlobe(canvasRef.current, Math.max(-60, Math.min(60, target.lat)), target.lon, report.subsolar);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minuteKey, target.lat, target.lon]);

  useEffect(() => {
    if (__TERRAX_PREVIEW__) {
      setKp({ reading: null, error: 'Live data is blocked in this preview', loading: false });
      return;
    }
    let cancelled = false;
    const load = async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const reading = await fetchKp(ctrl.signal);
        if (!cancelled) setKp({ reading, error: reading ? null : 'No recent value', loading: false });
      } catch {
        if (!cancelled) setKp({ reading: null, error: 'Unavailable (offline?)', loading: false });
      } finally {
        clearTimeout(timer);
      }
    };
    load();
    const id = setInterval(load, 15 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const eot = report.equationOfTime;
  const dayLength = report.sunrise && report.sunset ? (report.sunset.getTime() - report.sunrise.getTime()) / 3_600_000 : null;

  return (
    <div className="telemetry-panel-inner">
      <div className="panel-header">
        <span className="pulse-dot" aria-hidden="true" /> Planetary telemetry
      </div>

      <canvas ref={canvasRef} className="globe" style={{ width: SIZE, height: SIZE }} role="img" aria-label={`Globe centred on ${target.name} showing day and night`} />
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
        <Row label="Mean solar time" value={formatClock(report.meanSolarTime)} title="UTC + longitude / 15" />
        <Row label="Apparent solar time" value={formatClock(report.apparentSolarTime)} title="Sundial time: mean solar time + equation of time" />
        <Row label="Equation of time" value={`${eot >= 0 ? '+' : '−'}${Math.abs(eot).toFixed(1)} min`} />
      </div>

      <div className="telemetry-section">
        <div className="eyebrow">Sun at target</div>
        <Row label="Altitude" value={`${report.altitude.toFixed(2)}°`} />
        <Row label="Zenith angle" value={`${report.zenith.toFixed(2)}°`} />
        <Row label="Azimuth (true N)" value={`${report.azimuth.toFixed(2)}°`} />
        <Row label="Declination" value={`${report.declination.toFixed(2)}°`} />
        <Row label="Sunrise" value={utcClock(report.sunrise)} />
        <Row label="Sunset" value={utcClock(report.sunset)} />
        <Row label="Day length" value={dayLength !== null ? `${Math.floor(Math.round(dayLength * 60) / 60)} h ${Math.round(dayLength * 60) % 60} min` : '—'} />
      </div>

      <div className="telemetry-section">
        <div className="eyebrow">Space weather (NOAA SWPC)</div>
        <Row label="Planetary Kp" value={kp.loading ? 'Loading…' : kp.reading ? `${kp.reading.kp.toFixed(2)} · ${describeKp(kp.reading.kp)}` : kp.error ?? '—'} />
        {kp.reading && <Row label="Interval start" value={`${kp.reading.time.toISOString().slice(0, 16).replace('T', ' ')} UTC`} />}
      </div>
      <p className="panel-foot">
        Target {Math.abs(target.lat).toFixed(3)}° {target.lat >= 0 ? 'N' : 'S'}, {Math.abs(target.lon).toFixed(3)}° {target.lon >= 0 ? 'E' : 'W'} · change in Settings
      </p>
    </div>
  );
}
