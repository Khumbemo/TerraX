import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contourGrid, fillDepressions, flowRouting, niceInterval, snapOutlet, watershed } from '../src/lib/tools/hydrology';

const unit = { spacing: () => ({ dx: 10, dy: 10 }), cellArea: () => 100 };
const grid = (w: number, h: number, f: (x: number, y: number) => number) => {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = f(x, y);
  return { width: w, height: h, data, resampleFactor: 1 };
};

test('Priority-Flood fills a pit to its spill level', () => {
  const g = grid(5, 5, (x, y) => (x === 2 && y === 2 ? 0 : x === 0 || y === 0 || x === 4 || y === 4 ? 5 : 10));
  const { filled, raisedCells } = fillDepressions(g.data, 5, 5);
  assert.ok(filled[12] >= 10 && filled[12] < 10.001, `pit ${filled[12]}`);
  assert.equal(raisedCells, 1);
  // Every cell drains after filling: D8 finds a downhill neighbour or the edge.
  const f = flowRouting(g, unit, 1e9);
  const outflow = Array.from(f.dir).filter(d => d < 0).length;
  assert.ok(outflow <= 16, 'only edge cells may lack a downhill neighbour');
});

test('D8 on a tilted plane and accumulated area', () => {
  const w = 6, h = 4;
  const f = flowRouting(grid(w, h, x => 100 - x), unit, 1e9);
  for (let y = 0; y < h; y++) for (let x = 0; x < w - 1; x++) assert.equal(f.dir[y * w + x], 4, `east at ${x},${y}`);
  // The last column collects its whole row: 6 cells × 100 m².
  for (let y = 0; y < h; y++) assert.equal(f.acc[y * w + w - 1], 600);
});

test('Strahler order: two first-order branches make a second-order trunk', () => {
  const w = 13, h = 22;
  // Y-shaped valley: branches from (2,0) and (10,0) meet at (6,10); trunk runs south.
  const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
    const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
    return Math.hypot(px - ax - t * (bx - ax), py - ay - t * (by - ay));
  };
  const g = grid(w, h, (x, y) => {
    const d = Math.min(segDist(x, y, 2, 0, 6, 10), segDist(x, y, 10, 0, 6, 10), segDist(x, y, 6, 10, 6, 21));
    return 200 - 2 * y + 8 * d;
  });
  const f = flowRouting(g, unit, 900); // channels start at 9 cells
  assert.equal(f.maxOrder, 2);
  const trunk = 20 * w + 6;
  assert.equal(f.order[trunk], 2);
  assert.ok(f.order[6 * w + 4] === 1 || f.order[6 * w + 3] === 1, 'branch cells are first order');
  const outlet = snapOutlet(f, 6, 21, 1);
  const ws = watershed(f, outlet);
  assert.ok(ws.cells > w * 10, `watershed ${ws.cells} cells`);
  assert.equal(ws.mask[2 * w + 3], 1, 'the west branch drains to the outlet');
  assert.equal(ws.mask[2], 0, 'an edge cell lower than its neighbours drains off the grid');
  assert.ok(f.lengthByOrder[1] > 0 && f.lengthByOrder[2] > 0);
});

test('contours: a plane gives one straight chained line per level', () => {
  const w = 5, h = 6;
  const z = grid(w, h, x => x).data;
  const [{ level, lines }] = contourGrid(z, w, h, [1.5]);
  assert.equal(level, 1.5);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].length, h);
  assert.ok(lines[0].every(p => Math.abs(p[0] - 2) < 1e-9), 'x = 2 (between cell centres 1.5 and 2.5)');
  const ys = lines[0].map(p => p[1]).sort((a, b) => a - b);
  assert.deepEqual([ys[0], ys[ys.length - 1]], [0.5, h - 0.5]);
  assert.equal(niceInterval(1000), 100);
  assert.equal(niceInterval(730), 50);
  assert.equal(niceInterval(18), 2);
});
