// Planetary K-index from NOAA's Space Weather Prediction Center.
// https://www.swpc.noaa.gov/products/planetary-k-index

const KP_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';

export interface KpReading {
  kp: number;
  /** Start of the 3-hour interval (UTC). */
  time: Date;
  label: string;
}

/** NOAA G-scale: Kp 5 = G1 (minor) … Kp 9 = G5 (extreme). */
export function describeKp(kp: number): string {
  if (kp >= 9) return 'G5 extreme storm';
  if (kp >= 8) return 'G4 severe storm';
  if (kp >= 7) return 'G3 strong storm';
  if (kp >= 6) return 'G2 moderate storm';
  if (kp >= 5) return 'G1 minor storm';
  if (kp >= 4) return 'Active';
  if (kp >= 3) return 'Unsettled';
  return 'Quiet';
}

function parseTime(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const d = new Date(/Z|[+-]\d\d:?\d\d$/.test(v) ? v : `${v.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Accepts both formats SWPC has used: an array of arrays with a header row, or an array of objects. */
export function parseKpFeed(json: unknown): KpReading | null {
  if (!Array.isArray(json) || json.length === 0) return null;
  let rows: { time: unknown; kp: unknown }[] = [];
  if (Array.isArray(json[0])) {
    const header = (json[0] as unknown[]).map(h => String(h).toLowerCase());
    const ti = header.indexOf('time_tag');
    const ki = header.findIndex(h => h === 'kp' || h === 'kp_index');
    if (ti < 0 || ki < 0) return null;
    rows = json.slice(1).map(r => ({ time: (r as unknown[])[ti], kp: (r as unknown[])[ki] }));
  } else {
    rows = json.map(r => {
      const o = r as Record<string, unknown>;
      return { time: o.time_tag, kp: o.Kp ?? o.kp ?? o.kp_index };
    });
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const kp = Number(rows[i].kp);
    const time = parseTime(rows[i].time);
    if (Number.isFinite(kp) && time) return { kp, time, label: describeKp(kp) };
  }
  return null;
}

export async function fetchKp(signal?: AbortSignal): Promise<KpReading | null> {
  const res = await fetch(KP_URL, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`SWPC returned HTTP ${res.status}`);
  return parseKpFeed(await res.json());
}
