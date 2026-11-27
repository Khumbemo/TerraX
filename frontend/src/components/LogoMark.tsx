import type { ReactNode } from 'react';

/**
 * The TerraX mark: the Earth with two crossing orbits that form the X, and a satellite. The land comes from Natural Earth
 * (via world-atlas) in an orthographic view centred on north-east India; scripts/make-logo.tsx draws the static files
 * (public/logo.svg, favicon and app icons) from this component, and the opening animation turns the same globe.
 */
export const LOGO = {
  /** Globe radius in the 512 × 512 drawing. */
  r: 132,
  /** d3 orthographic rotation [−longitude, −latitude] of the centre of the view. */
  view: [-90, -18] as [number, number],
  orbit: { rx: 214, ry: 62, tilt: 35, width: 13 },
  /** Where the satellite sits on the +35° orbit (degrees from its right end). */
  satAngle: 62,
};

export function satellitePosition(angleDeg = LOGO.satAngle): [number, number] {
  const t = (angleDeg * Math.PI) / 180,
    a = (LOGO.orbit.tilt * Math.PI) / 180;
  const x = LOGO.orbit.rx * Math.cos(t),
    y = LOGO.orbit.ry * Math.sin(t);
  return [256 + x * Math.cos(a) - y * Math.sin(a), 256 + x * Math.sin(a) + y * Math.cos(a)];
}

interface Props {
  /** SVG path data of the land and the graticule on the globe (orthographic, radius LOGO.r, centred at 256, 256). */
  land: string;
  graticule: string;
  /** Prefix for gradient ids, unique per mark on a page. */
  id?: string;
  /** A dark tile behind the mark: rounded (app icon), full (maskable icon, mark in the safe zone) or none. */
  tile?: 'rounded' | 'full' | 'none';
  className?: string;
  /** Satellite position along its orbit, in degrees; null hides it. */
  satellite?: number | null;
  /** Extra content drawn on top (the animation's sparkle). */
  children?: ReactNode;
  title?: string;
}

export default function LogoMark({ land, graticule, id = 'tx', tile = 'none', className, satellite = LOGO.satAngle, children, title }: Props) {
  const { r, orbit } = LOGO;
  const u = (n: string) => `${id}-${n}`;
  const ring = (deg: number, front: boolean) => (
    <g transform={`translate(256 256) rotate(${deg})`} className={`logo-orbit logo-orbit-${front ? 'front' : 'back'} logo-orbit-${deg < 0 ? 'a' : 'b'}`}>
      <g clipPath={front ? `url(#${u('front')})` : undefined}>
        <ellipse
          rx={orbit.rx}
          ry={orbit.ry}
          fill="none"
          stroke={`url(#${u('orbit')})`}
          strokeWidth={orbit.width}
          strokeLinecap="round"
          opacity={front ? undefined : 0.42}
          pathLength={1}
        />
      </g>
    </g>
  );
  const sat = satellite == null ? null : satellitePosition(satellite);
  const mark = (
    <>
      {ring(-orbit.tilt, false)}
      {ring(orbit.tilt, false)}
      <g className="logo-globe">
        <circle cx={256} cy={256} r={r + 26} fill={`url(#${u('halo')})`} />
        <circle cx={256} cy={256} r={r} fill={`url(#${u('sea')})`} />
        <g clipPath={`url(#${u('globe')})`}>
          <path d={graticule} fill="none" stroke="#bae6fd" strokeOpacity={0.16} strokeWidth={1.4} />
          <path className="logo-land" d={land} fill={`url(#${u('land')})`} stroke="#a7f3d0" strokeOpacity={0.5} strokeWidth={1} />
          <rect x={256 - r} y={256 - r} width={2 * r} height={2 * r} fill={`url(#${u('night')})`} />
        </g>
        <circle cx={256} cy={256} r={r} fill="none" stroke="#7dd3fc" strokeOpacity={0.55} strokeWidth={2} />
      </g>
      {ring(-orbit.tilt, true)}
      {ring(orbit.tilt, true)}
      {sat && (
        <g className="logo-satellite">
          <circle cx={sat[0]} cy={sat[1]} r={26} fill={`url(#${u('sat')})`} />
          <circle cx={sat[0]} cy={sat[1]} r={9} fill="#fff" />
        </g>
      )}
      {children}
    </>
  );
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" className={className} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <defs>
        <radialGradient id={u('sea')} cx="36%" cy="30%" r="78%">
          <stop offset="0" stopColor="#4cc9f0" />
          <stop offset=".5" stopColor="#1166a8" />
          <stop offset="1" stopColor="#05213d" />
        </radialGradient>
        <linearGradient id={u('land')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6ee7b7" />
          <stop offset="1" stopColor="#059669" />
        </linearGradient>
        <linearGradient id={u('night')} x1="0" y1="0" x2="1" y2="1">
          <stop offset=".45" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000814" stopOpacity=".78" />
        </linearGradient>
        <linearGradient id={u('orbit')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#38bdf8" />
          <stop offset=".5" stopColor="#a5f3fc" />
          <stop offset="1" stopColor="#34d399" />
        </linearGradient>
        <radialGradient id={u('halo')} r=".5">
          <stop offset=".74" stopColor="#38bdf8" stopOpacity=".55" />
          <stop offset=".82" stopColor="#38bdf8" stopOpacity=".12" />
          <stop offset="1" stopColor="#38bdf8" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={u('sat')}>
          <stop offset="0" stopColor="#fff" />
          <stop offset=".35" stopColor="#e0f2fe" />
          <stop offset="1" stopColor="#38bdf8" stopOpacity="0" />
        </radialGradient>
        <clipPath id={u('globe')}>
          <circle cx={256} cy={256} r={r} />
        </clipPath>
        <clipPath id={u('front')} clipPathUnits="userSpaceOnUse">
          <rect x={-300} y={0} width={600} height={300} />
        </clipPath>
      </defs>
      {tile === 'rounded' && <rect width={512} height={512} rx={112} fill="#050a14" />}
      {tile === 'full' ? (
        <>
          <rect width={512} height={512} fill="#050a14" />
          <g transform="translate(51.2 51.2) scale(.8)">{mark}</g>
        </>
      ) : (
        mark
      )}
    </svg>
  );
}
