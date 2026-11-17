// Water grid from the (smoothed) coastline:
//   1. rasterize coast lines as barriers, flood-fill water from seed points
//   2. Euclidean distance from every water cell to the nearest land (metres)
//   3. ripples  = contour lines of that distance field (true buffers, in metres)
//      navgrid  = the same field at coarser cells, for the land-avoiding router
// usage: node scripts/water.mjs <place>
//   → places/<place>/data/ripples.geojson, navgrid.png, navgrid.json
import fs from 'node:fs';
import { PNG } from 'pngjs';
import { contours } from 'd3-contour';

const place = process.argv[2] || 'richardson-bay';
const cfg = JSON.parse(fs.readFileSync(`places/${place}/place.json`, 'utf8'));
const coast = JSON.parse(fs.readFileSync(`places/${place}/data/coast.geojson`, 'utf8'));
const water = cfg.water || {};
const CELL = water.cell || 6;                         // metres per cell
const RIPPLES = water.ripples || [12, 30, 55, 90];    // metres from shore
const seeds = water.seeds;                            // [lon,lat] points known to be open water
if (!seeds?.length) throw new Error('place.json needs water.seeds: [[lon,lat], ...]');

const [w, s, e, n] = cfg.bbox;
const lat0 = ((s + n) / 2) * Math.PI / 180;
const mx = 111320 * Math.cos(lat0), my = 110540;
const W = Math.ceil(((e - w) * mx) / CELL), H = Math.ceil(((n - s) * my) / CELL);
const toGrid = ([lon, lat]) => [((lon - w) * mx) / CELL, ((n - lat) * my) / CELL];
const toLL = (x, y) => [+(w + (x * CELL) / mx).toFixed(6), +(n - (y * CELL) / my).toFixed(6)];
console.log(`grid ${W}×${H} @ ${CELL} m`);

// 1. barriers (8-connected Bresenham) + 4-connected flood fill → can't leak through diagonals
const barrier = new Uint8Array(W * H);
const plot = (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) barrier[y * W + x] = 1; };
function line([x0, y0], [x1, y1]) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) { plot(x0, y0); if (x0 === x1 && y0 === y1) break; const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; } if (e2 <= dx) { err += dx; y0 += sy; } }
}
for (const f of coast.features) { const c = f.geometry.coordinates.map(toGrid); for (let i = 1; i < c.length; i++) line(c[i - 1], c[i]); }

const isWater = new Uint8Array(W * H);
const stack = [];
for (const sd of seeds) { const [x, y] = toGrid(sd).map(Math.round); stack.push(y * W + x); }
while (stack.length) {
  const i = stack.pop();
  if (isWater[i] || barrier[i]) continue;
  isWater[i] = 1;
  const x = i % W, y = (i / W) | 0;
  if (x > 0) stack.push(i - 1); if (x < W - 1) stack.push(i + 1);
  if (y > 0) stack.push(i - W); if (y < H - 1) stack.push(i + W);
}
let wc = 0; for (const v of isWater) wc += v;
console.log(`water ${(100 * wc / (W * H)).toFixed(1)}% of grid`);

// 2. exact Euclidean distance transform (Felzenszwalb & Huttenlocher)
const INF = 1e20;
function edt1d(f, n) {
  const d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s2;
    do { const r = v[k]; s2 = ((f[q] + q * q) - (f[r] + r * r)) / (2 * q - 2 * r); } while (s2 <= z[k] && --k >= 0);
    k++; v[k] = q; z[k] = s2; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const r = v[k]; d[q] = (q - r) * (q - r) + f[r]; }
  return d;
}
const dist = new Float64Array(W * H);
for (let i = 0; i < W * H; i++) dist[i] = isWater[i] ? INF : 0;
const col = new Float64Array(H);
for (let x = 0; x < W; x++) { for (let y = 0; y < H; y++) col[y] = dist[y * W + x]; const d = edt1d(col, H); for (let y = 0; y < H; y++) dist[y * W + x] = d[y]; }
const row = new Float64Array(W);
for (let y = 0; y < H; y++) { for (let x = 0; x < W; x++) row[x] = dist[y * W + x]; const d = edt1d(row, W); for (let x = 0; x < W; x++) dist[y * W + x] = Math.sqrt(d[x]) * CELL; }

// 3a. ripples: contours of the distance field, Chaikin-smoothed
function chaikin(p) {
  const out = [];
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i], b = p[i + 1];
    out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
  }
  out.push(out[0]);
  return out;
}
// Douglas–Peucker, tolerance in cells (0.25 × 6 m = 1.5 m)
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const [fx, fy] = pts[0], [lx, ly] = pts[pts.length - 1];
  if (fx === lx && fy === ly) { // closed ring: split at the point farthest from the start, simplify both halves
    let m = 1, md = -1;
    pts.forEach(([x, y], i) => { const d = (x - fx) ** 2 + (y - fy) ** 2; if (d > md) { md = d; m = i; } });
    return simplify(pts.slice(0, m + 1), tol).concat(simplify(pts.slice(m), tol).slice(1));
  }
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
    let best = -1, bd = tol;
    for (let i = a + 1; i < b; i++) { const d = Math.abs(dy * (pts[i][0] - ax) - dx * (pts[i][1] - ay)) / L; if (d > bd) { bd = d; best = i; } }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const features = [];
for (const c of contours().size([W, H]).thresholds(RIPPLES)(Array.from(dist))) {
  for (const poly of c.coordinates) for (const ring of poly) {
    if (ring.length < 12) continue; // specks
    let r = simplify(ring, 0.25); for (let k = 0; k < 3; k++) r = chaikin(r); r = simplify(r, 0.12);
    // the tracer closes rings along the grid edge: cut those stretches out
    const edge = ([x, y]) => x < 2 || y < 2 || x > W - 2 || y > H - 2;
    let run = [];
    const flush = () => { if (run.length > 8) features.push({ type: 'Feature', properties: { d: c.value, step: RIPPLES.indexOf(c.value) },
      geometry: { type: 'LineString', coordinates: run.filter((_, i) => i % 2 === 0 || i === run.length - 1).map(([x, y]) => toLL(x, y)) } }); run = []; };
    for (const p of r) { if (edge(p)) flush(); else run.push(p); }
    flush();
  }
}
fs.writeFileSync(`places/${place}/data/ripples.geojson`, JSON.stringify({ type: 'FeatureCollection', features }));
console.log(`ripples: ${features.length} lines at ${RIPPLES.join(', ')} m`);

// 3b. navgrid: 2×2 blocks, min distance, in units of the coarse cell, capped at 255
const F = 2, GW = Math.ceil(W / F), GH = Math.ceil(H / F), GC = CELL * F;
const png = new PNG({ width: GW, height: GH });
for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
  let m = INF;
  for (let dy = 0; dy < F; dy++) for (let dx = 0; dx < F; dx++) {
    const x = gx * F + dx, y = gy * F + dy; if (x < W && y < H) m = Math.min(m, dist[y * W + x]);
  }
  const v = Math.min(255, Math.floor(m / GC)), o = (gy * GW + gx) * 4;
  png.data[o] = png.data[o + 1] = png.data[o + 2] = v; png.data[o + 3] = 255;
}
fs.writeFileSync(`places/${place}/data/navgrid.png`, PNG.sync.write(png));
fs.writeFileSync(`places/${place}/data/navgrid.json`, JSON.stringify({ bbox: cfg.bbox, width: GW, height: GH, cell: GC, lat0: (s + n) / 2 }));
console.log(`navgrid ${GW}×${GH} @ ${GC} m → ${(fs.statSync(`places/${place}/data/navgrid.png`).size / 1024).toFixed(0)} KB`);
