import { useEffect, useRef, useState } from 'react';
import { idbGet } from '../lib/idb';
import { usePrefs } from '../lib/prefs';
import { decodeCities, landMask, renderEarth, renderGalaxy, type Cities, type LandShapes } from '../lib/space-render';

interface Props {
  target: { lat: number; lon: number };
}

let maskPromise: Promise<Uint8Array> | null = null;
function loadMask(): Promise<Uint8Array> {
  if (!maskPromise) {
    maskPromise = Promise.all([import('world-atlas/land-50m.json'), import('topojson-client')]).then(([topo, { feature }]) => {
      const t = topo.default;
      return landMask(feature(t, t.objects.land) as unknown as LandShapes);
    });
  }
  return maskPromise;
}

let citiesPromise: Promise<Cities> | null = null;
function loadCities(): Promise<Cities> {
  if (!citiesPromise) citiesPromise = import('../lib/data/city-lights').then(m => decodeCities(m.CITY_DATA, m.MIN_POPULATION));
  return citiesPromise;
}

const isEarth = (b: string) => b === 'earth' || b === 'earth-night';

/** Full-window decorative background: Earth from orbit, a galaxy, or the user's own image. */
export default function SpaceBackground({ target }: Props) {
  const { background, theme, customBgVersion } = usePrefs();
  const ref = useRef<HTMLCanvasElement>(null);
  const [custom, setCustom] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const active = background !== 'off' && theme !== 'light';

  // Re-render the Earth every 10 minutes so the day/night line moves; redraw on resize.
  useEffect(() => {
    if (!active || !isEarth(background)) return;
    const id = window.setInterval(() => setTick(t => t + 1), 10 * 60_000);
    return () => window.clearInterval(id);
  }, [active, background]);
  useEffect(() => {
    let timer = 0;
    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setTick(t => t + 1), 250);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (!active || background !== 'custom') return;
    let url: string | null = null;
    idbGet<Blob>('background').then(blob => {
      if (blob) {
        url = URL.createObjectURL(blob);
        setCustom(url);
      } else setCustom(null);
    });
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [active, background, customBgVersion]);

  useEffect(() => {
    const c = ref.current;
    if (!active || !c || (!isEarth(background) && background !== 'galaxy')) return;
    let alive = true;
    // Draw at device resolution, up to 2560 px wide (city lights need the detail).
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const s = Math.min(dpr, 2560 / window.innerWidth);
    const w = Math.max(320, Math.round(window.innerWidth * s)), h = Math.max(240, Math.round(window.innerHeight * s));
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    if (background === 'galaxy') renderGalaxy(ctx, w, h);
    else
      Promise.all([loadMask(), loadCities().catch(() => null)])
        .then(([mask, cities]) => alive && renderEarth(ctx, w, h, mask, target, new Date(), background === 'earth-night' ? 'night' : 'live', cities))
        .catch(err => console.warn('TerraX: Earth background unavailable', err));
    return () => {
      alive = false;
    };
  }, [active, background, target.lat, target.lon, tick]);

  if (!active) return <div className="earth-background" aria-hidden="true" />;
  return (
    <div className={`space-background bg-${isEarth(background) ? 'earth' : background}`} aria-hidden="true">
      {background === 'custom' ? custom && <div className="space-custom" style={{ backgroundImage: `url(${custom})` }} /> : <canvas ref={ref} className="space-canvas" />}
      <div className="space-shade" />
    </div>
  );
}
