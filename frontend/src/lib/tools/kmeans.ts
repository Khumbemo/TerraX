// k-means (Lloyd 1982) with k-means++ seeding (Arthur & Vassilvitskii 2007).
// Kept free of other app imports so the compute worker can load it.

export function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * k-means on n points of dimension d (row-major). Returns centroids and the
 * number of iterations; deterministic for a given seed.
 */
export function kmeans(points: Float64Array, d: number, k: number, seed = 1, maxIter = 100): { centroids: Float64Array; iterations: number; sse: number } {
  const n = points.length / d;
  if (n < k) throw new Error(`Only ${n} valid pixels for ${k} classes.`);
  const rand = rng(seed);
  const c = new Float64Array(k * d);
  const dist2 = (i: number, j: number, cent: Float64Array) => {
    let s = 0;
    for (let a = 0; a < d; a++) {
      const v = points[i * d + a] - cent[j * d + a];
      s += v * v;
    }
    return s;
  };
  // k-means++ seeding: first centre uniform, then proportional to D².
  const first = Math.floor(rand() * n);
  for (let a = 0; a < d; a++) c[a] = points[first * d + a];
  const best = new Float64Array(n).fill(Infinity);
  for (let j = 1; j < k; j++) {
    let total = 0;
    for (let i = 0; i < n; i++) {
      best[i] = Math.min(best[i], dist2(i, j - 1, c));
      total += best[i];
    }
    let target = rand() * total;
    let pick = n - 1;
    for (let i = 0; i < n; i++) {
      target -= best[i];
      if (target <= 0) {
        pick = i;
        break;
      }
    }
    for (let a = 0; a < d; a++) c[j * d + a] = points[pick * d + a];
  }
  const assign = new Int32Array(n).fill(-1);
  let iterations = 0;
  let sse = 0;
  for (; iterations < maxIter; iterations++) {
    let changed = 0;
    sse = 0;
    for (let i = 0; i < n; i++) {
      let bj = 0, bd = Infinity;
      for (let j = 0; j < k; j++) {
        const dd = dist2(i, j, c);
        if (dd < bd) {
          bd = dd;
          bj = j;
        }
      }
      sse += bd;
      if (assign[i] !== bj) {
        assign[i] = bj;
        changed++;
      }
    }
    const sum = new Float64Array(k * d);
    const cnt = new Float64Array(k);
    for (let i = 0; i < n; i++) {
      const j = assign[i];
      cnt[j]++;
      for (let a = 0; a < d; a++) sum[j * d + a] += points[i * d + a];
    }
    for (let j = 0; j < k; j++) {
      if (!cnt[j]) continue; // keep an empty cluster's centre where it was
      for (let a = 0; a < d; a++) c[j * d + a] = sum[j * d + a] / cnt[j];
    }
    if (!changed) break;
  }
  return { centroids: c, iterations: iterations + 1, sse };
}
