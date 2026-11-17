// Land-avoiding paddling router.
// navgrid.png holds, for each 12 m cell, the distance to the nearest land in cells
// (from scripts/water.mjs). A cell is open water if it's at least `buffer` metres
// from shore. Legs are found with A*, then pulled tight with line-of-sight
// shortcuts so they stay straight across open water and only bend around points.

export class Router {
  static async load(base) {
    const meta = await fetch(`${base}/data/navgrid.json`).then(r => (r.ok ? r.json() : null)).catch(() => null);
    if (!meta) return null;
    // createImageBitmap also works in background tabs (img.decode() can stall there),
    // and with colour conversion off the grey values come through untouched
    const blob = await fetch(`${base}/data/navgrid.png`).then(r => r.blob());
    const img = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const cv = new OffscreenCanvas(meta.width, meta.height);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, meta.width, meta.height).data;
    const dist = new Uint8Array(meta.width * meta.height);
    for (let i = 0; i < dist.length; i++) dist[i] = px[i * 4];
    return new Router(meta, dist);
  }

  constructor(meta, dist, buffer = 30) {
    Object.assign(this, { meta, dist, W: meta.width, H: meta.height });
    const [w, , , n] = meta.bbox;
    this.mx = 111320 * Math.cos(meta.lat0 * Math.PI / 180);
    this.my = 110540;
    this.w = w; this.n = n;
    this.setBuffer(buffer);
  }

  setBuffer(m) { this.buffer = m; this.minCells = Math.ceil(m / this.meta.cell); }
  open(i) { return this.dist[i] >= this.minCells; }
  toCell([lon, lat]) {
    const x = Math.round(((lon - this.w) * this.mx) / this.meta.cell), y = Math.round(((this.n - lat) * this.my) / this.meta.cell);
    return [Math.max(0, Math.min(this.W - 1, x)), Math.max(0, Math.min(this.H - 1, y))];
  }
  toLL(x, y) { return [this.w + (x * this.meta.cell) / this.mx, this.n - (y * this.meta.cell) / this.my]; }

  // nearest open-water cell (beaches and launches sit on land; we paddle out from them)
  snap(x, y) {
    if (this.open(y * this.W + x)) return [x, y];
    for (let r = 1; r < 200; r++) {
      let best = null, bd = Infinity;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= this.W || Y >= this.H || !this.open(Y * this.W + X)) continue;
        const d = dx * dx + dy * dy; if (d < bd) { bd = d; best = [X, Y]; }
      }
      if (best) return best;
    }
    return null;
  }

  // every cell on the straight line between two cells is open water
  clear([x0, y0], [x1, y1]) {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
    for (let k = 0; k <= n; k++) {
      const x = Math.round(x0 + ((x1 - x0) * k) / n), y = Math.round(y0 + ((y1 - y0) * k) / n);
      if (!this.open(y * this.W + x)) return false;
    }
    return true;
  }

  astar(a, b) {
    const { W, H } = this, start = a[1] * W + a[0], goal = b[1] * W + b[0];
    const g = new Float32Array(W * H).fill(Infinity), from = new Int32Array(W * H).fill(-1), done = new Uint8Array(W * H);
    const h = (i) => { const dx = Math.abs((i % W) - b[0]), dy = Math.abs(((i / W) | 0) - b[1]); return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy); };
    const heap = [[h(start), start]]; g[start] = 0;
    const push = (item) => { heap.push(item); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    const steps = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
    while (heap.length) {
      const [, i] = pop();
      if (done[i]) continue;
      if (i === goal) break;
      done[i] = 1;
      const x = i % W, y = (i / W) | 0;
      for (const [dx, dy, c] of steps) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const j = Y * W + X;
        if (done[j] || !this.open(j)) continue;
        const ng = g[i] + c;
        if (ng < g[j]) { g[j] = ng; from[j] = i; push([ng + h(j), j]); }
      }
    }
    if (from[goal] === -1 && goal !== start) return null;
    const path = [];
    for (let i = goal; i !== -1; i = from[i]) path.push([i % W, (i / W) | 0]);
    return path.reverse();
  }

  // string-pulling: keep only the turns you actually need
  pull(path) {
    const out = [path[0]];
    let i = 0;
    while (i < path.length - 1) {
      let j = path.length - 1;
      while (j > i + 1 && !this.clear(path[i], path[j])) j--;
      out.push(path[j]); i = j;
    }
    return out;
  }

  // one leg between two lng/lat points; returns lng/lat coordinates
  leg(a, b) {
    const ca = this.snap(...this.toCell(a)), cb = this.snap(...this.toCell(b));
    if (!ca || !cb) return [a, b];
    const raw = this.clear(ca, cb) ? [ca, cb] : this.astar(ca, cb);
    if (!raw) return [a, b];
    return [a, ...this.pull(raw).map(([x, y]) => this.toLL(x, y)), b];
  }
}

export const NM = 1852;
export function metres(coords) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) {
    const [x1, y1] = coords[i - 1], [x2, y2] = coords[i], r = Math.PI / 180;
    const a = Math.sin((y2 - y1) * r / 2) ** 2 + Math.cos(y1 * r) * Math.cos(y2 * r) * Math.sin((x2 - x1) * r / 2) ** 2;
    d += 2 * 6371008.8 * Math.asin(Math.sqrt(a));
  }
  return d;
}
