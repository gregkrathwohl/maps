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
    this.visited = new Uint8Array(this.W * this.H);
  }
  resetVisited() { this.visited.fill(0); }
  // is this point water (by our coastline)? cells outside the grid count as water
  isWater(lng, lat) {
    const x = Math.round(((lng - this.w) * this.mx) / this.meta.cell), y = Math.round(((this.n - lat) * this.my) / this.meta.cell);
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return true;
    return this.dist[y * this.W + x] > 0;
  }

  // debug picture of the grid: land, inside the buffer, open water by distance, cells the search explored
  debugImage() {
    const { W, H } = this, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d'), img = ctx.createImageData(W, H);
    for (let i = 0; i < W * H; i++) {
      const d = this.dist[i], o = i * 4;
      let c;
      if (d === 0) c = [120, 110, 95, 150];                       // land
      else if (d < this.minCells) c = [230, 140, 60, 170];        // too close to shore
      else { const k = Math.min(1, d / 60); c = [40, 90 + 60 * (1 - k), 160 + 60 * (1 - k), 70 + 90 * k]; } // open water, darker = farther
      if (this.visited[i] && d >= this.minCells) c = [250, 220, 70, 190]; // explored by the search
      img.data.set(c, o);
    }
    ctx.putImageData(img, 0, 0);
    const [w, , , n] = this.meta.bbox, e = w + (W * this.meta.cell) / this.mx, s = n - (H * this.meta.cell) / this.my;
    return { url: cv.toDataURL(), coordinates: [[w, n], [e, n], [e, s], [w, s]] };
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

  // every cell on the straight line between two (possibly fractional) cell positions is open water
  clear([x0, y0], [x1, y1]) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
    for (let k = 0; k <= n; k++) {
      const x = Math.round(x0 + ((x1 - x0) * k) / n), y = Math.round(y0 + ((y1 - y0) * k) / n);
      if (!this.open(y * this.W + x)) return false;
    }
    return true;
  }

  // Lazy Theta*: A* whose parents can be any visible cell, so paths come out
  // any-angle instead of 8-directional. Line-of-sight is checked lazily, once per expansion.
  thetaStar(a, b) {
    const { W, H } = this, start = a[1] * W + a[0], goal = b[1] * W + b[0];
    const g = new Float32Array(W * H).fill(Infinity), par = new Int32Array(W * H).fill(-1), done = new Uint8Array(W * H);
    const xy = (i) => [i % W, (i / W) | 0];
    const d = (i, j) => { const [x1, y1] = xy(i), [x2, y2] = xy(j); return Math.hypot(x2 - x1, y2 - y1); };
    const heap = [];
    const push = (item) => { heap.push(item); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    const nbrs = (i) => { const [x, y] = xy(i), out = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue; const X = x + dx, Y = y + dy;
        if (X >= 0 && Y >= 0 && X < W && Y < H && this.open(Y * W + X)) out.push(Y * W + X);
      } return out; };
    g[start] = 0; par[start] = start; push([d(start, goal), start]);
    while (heap.length) {
      const [, s] = pop();
      if (done[s]) continue;
      // lazy check: if the parent can't actually see s, fall back to the best expanded neighbour
      if (par[s] !== s && !this.clear(xy(par[s]), xy(s))) {
        let best = Infinity;
        for (const n of nbrs(s)) if (done[n] && g[n] + d(n, s) < best) { best = g[n] + d(n, s); par[s] = n; }
        g[s] = best;
      }
      if (s === goal) break;
      done[s] = 1;
      for (const n of nbrs(s)) {
        if (done[n]) continue;
        const p = par[s], ng = g[p] + d(p, n);
        if (ng < g[n]) { g[n] = ng; par[n] = p; push([ng + d(n, goal), n]); }
      }
    }
    for (let i = 0; i < done.length; i++) if (done[i]) this.visited[i] = 1; // for the debug view
    if (par[goal] === -1) return null;
    const path = [];
    for (let i = goal; ; i = par[i]) { path.push(xy(i)); if (i === start) break; }
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

  // corner cutting: slide each turn toward its neighbours while the shortcut stays clear,
  // so the route wraps a point as tightly as the buffer allows
  tighten(path, passes = 3) {
    for (let k = 0; k < passes; k++) {
      const out = [path[0]];
      for (let i = 1; i < path.length - 1; i++) {
        const a = out[out.length - 1], v = path[i], b = path[i + 1];
        let lo = 0, hi = 0.5;
        for (let it = 0; it < 12; it++) {
          const t = (lo + hi) / 2;
          const A = [v[0] + (a[0] - v[0]) * t, v[1] + (a[1] - v[1]) * t], B = [v[0] + (b[0] - v[0]) * t, v[1] + (b[1] - v[1]) * t];
          if (this.clear(A, B)) lo = t; else hi = t;
        }
        if (lo < 0.01) out.push(v);
        else out.push([v[0] + (a[0] - v[0]) * lo, v[1] + (a[1] - v[1]) * lo], [v[0] + (b[0] - v[0]) * lo, v[1] + (b[1] - v[1]) * lo]);
      }
      out.push(path[path.length - 1]);
      path = this.pull(out);
    }
    return path;
  }

  // nearest open water to a point (for stops clicked on land: go as close as we can)
  toWater(ll) {
    const c = this.toCell(ll), s = this.snap(...c);
    if (!s || (s[0] === c[0] && s[1] === c[1])) return ll;
    return this.toLL(...s).map(v => +v.toFixed(5));
  }

  // one leg between two lng/lat points; returns lng/lat coordinates
  leg(a, b) {
    const ca = this.snap(...this.toCell(a)), cb = this.snap(...this.toCell(b));
    if (!ca || !cb) return [a, b];
    const raw = this.clear(ca, cb) ? [ca, cb] : this.thetaStar(ca, cb);
    if (!raw) return [a, b];
    return [a, ...this.tighten(this.pull(raw)).map(([x, y]) => this.toLL(x, y)), b];
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
