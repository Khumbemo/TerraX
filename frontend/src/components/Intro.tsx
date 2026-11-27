import { useCallback, useEffect, useRef, useState } from 'react';
import type { FeatureCollection } from 'geojson';
import LogoMark, { LOGO } from './LogoMark';
import { globePaths, landFrom } from '../lib/globe';

/** Seconds: stars rush past, the Earth turns in, the orbits draw, the name appears, then everything fades to the app. */
const T = { globeIn: 0.7, spinEnd: 2.9, orbits: 1.7, satellite: 2.9, word: 2.7, out: 4.6 };
const easeOut = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);

interface Props {
  onDone: () => void;
}

/** The opening animation, shown once when TerraX opens (Settings → Opening animation turns it off). */
export default function Intro({ onDone }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [land, setLand] = useState<FeatureCollection | null>(null);
  const [t, setT] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const finished = useRef(false);

  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    setLeaving(true);
    window.setTimeout(onDone, 450);
  }, [onDone]);

  useEffect(() => {
    let alive = true;
    import('world-atlas/land-110m.json').then(m => alive && setLand(landFrom(m.default)));
    return () => {
      alive = false;
    };
  }, []);

  // Skip with any key, a click or a tap.
  useEffect(() => {
    const skip = () => finish();
    window.addEventListener('keydown', skip);
    return () => window.removeEventListener('keydown', skip);
  }, [finish]);

  // One clock for the globe and the stars; it starts once the land has loaded.
  useEffect(() => {
    if (!land) return;
    if (reduced) {
      setT(T.out);
      const id = window.setTimeout(finish, 1400);
      return () => window.clearTimeout(id);
    }
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      if (!c) return;
      c.width = Math.round(window.innerWidth * dpr);
      c.height = Math.round(window.innerHeight * dpr);
    };
    resize();
    window.addEventListener('resize', resize);
    // Stars in a tunnel: x, y on the sky, z the distance; they fly toward the viewer and slow down.
    const stars = Array.from({ length: 900 }, () => ({ x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: Math.random() * 0.95 + 0.05, h: 190 + Math.random() * 60 }));
    const start = performance.now();
    let last = start;
    let raf = 0;
    const frame = (now: number) => {
      const s = (now - start) / 1000;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      setT(s);
      if (c && ctx) {
        const w = c.width,
          h = c.height,
          cx = w / 2,
          cy = h / 2,
          f = Math.max(w, h) * 0.5;
        const speed = 0.04 + 1.6 * Math.exp(-s * 1.5);
        ctx.fillStyle = `rgba(2, 4, 10, ${speed > 0.3 ? 0.35 : 1})`;
        ctx.fillRect(0, 0, w, h);
        for (const st of stars) {
          const z0 = st.z;
          st.z -= speed * dt;
          if (st.z <= 0.02) {
            st.x = Math.random() * 2 - 1;
            st.y = Math.random() * 2 - 1;
            st.z = 1;
            continue;
          }
          const x = cx + (st.x / st.z) * f * 0.5,
            y = cy + (st.y / st.z) * f * 0.5;
          const px = cx + (st.x / z0) * f * 0.5,
            py = cy + (st.y / z0) * f * 0.5;
          const b = Math.min(1, (1 - st.z) * 1.4);
          ctx.strokeStyle = `hsla(${st.h}, 80%, ${70 + 25 * b}%, ${b})`;
          ctx.lineWidth = (0.6 + 1.8 * (1 - st.z)) * dpr;
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
      }
      if (s >= T.out) finish();
      else raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, [land, reduced, finish]);

  // The Earth turns 200° eastward and settles on the logo's view.
  const spin = 1 - easeOut((t - T.globeIn) / (T.spinEnd - T.globeIn));
  const paths = land ? globePaths(land, [LOGO.view[0] + 200 * spin, LOGO.view[1]]) : null;
  const grow = easeOut((t - T.globeIn + 0.2) / 1.1);
  const sat = t >= T.satellite ? LOGO.satAngle - 140 * (1 - easeOut((t - T.satellite) / 1.2)) : null;

  return (
    <div className={`intro${leaving ? ' intro-leaving' : ''}${land ? ' intro-running' : ''}`} role="presentation" onPointerDown={finish} data-testid="intro">
      <canvas ref={canvas} className="intro-stars" aria-hidden="true" />
      <div className="intro-stage">
        {paths && (
          <div className="intro-mark" style={{ transform: `scale(${0.15 + 0.85 * grow})`, opacity: Math.min(1, grow * 1.5) }}>
            <LogoMark land={paths.land} graticule={paths.graticule} id="intro" satellite={sat} className={t >= T.orbits ? 'orbits-on' : ''} />
          </div>
        )}
        <div className={`intro-word${t >= T.word ? ' on' : ''}`}>
          <span className="intro-name">
            TERRA<span className="intro-x">X</span>
          </span>
          <span className="intro-tag">Earth observation workbench</span>
        </div>
      </div>
      <button type="button" className="intro-skip" onClick={finish}>
        Skip
      </button>
    </div>
  );
}
