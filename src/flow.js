// Animated surface currents from NOAA SFBOFS (scripts/fetch-sfbofs.py).
// A living background: streaks drifting with the water. Strength shows as motion
// (faster, longer streaks); an optional mode also colours them by speed.
//
// The streaks are drawn *in the map*: a canvas that covers the current view (plus a
// margin) at screen resolution, given to MapLibre as a canvas source + raster layer.
// So it sits in the style's stacking order (under labels and buoys), stays crisp, and
// moves with the map while panning; after each pan/zoom it re-fits to the new view.
// Particles live in lng/lat and move at a fixed multiple of the real current.

const SPEEDUP = 420;     // streaks move this many times faster than the water
const FPS = 30;
const MARGIN = 0.1;      // canvas reaches 10% beyond the view on each side
const RAMP = [[0, [79, 143, 192]], [0.4, [70, 167, 140]], [0.8, [226, 177, 60]], [1.3, [212, 85, 58]]];

export class FlowLayer {
  constructor(map, data, { onTime, beforeId, isWater } = {}) {
    Object.assign(this, { map, data, onTime, beforeId, isWater });
    const [w, , , n] = data.bbox;
    this.gw = w; this.gn = n;
    this.gmx = 111320 * Math.cos(((data.bbox[1] + data.bbox[3]) / 2) * Math.PI / 180);
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.t = this.nowIndex();
    this.colour = false;
    this.visible = true;
    this.fit();
    this.attach();
    map.on('style.load', () => this.attach());
    map.on('moveend', () => { this.fit(); this.map.getSource('flow')?.setCoordinates(this.coords); });
    map.on('resize', () => { this.fit(); this.map.getSource('flow')?.setCoordinates(this.coords); });
  }

  attach() {
    const { map } = this;
    if (!map.getStyle() || map.getSource('flow')) return;
    map.addSource('flow', { type: 'canvas', canvas: this.canvas, coordinates: this.coords, animate: true });
    map.addLayer({ id: 'flow', type: 'raster', source: 'flow',
      layout: { visibility: this.visible ? 'visible' : 'none' },
      paint: { 'raster-fade-duration': 0, 'raster-resampling': 'linear' } },
      map.getLayer(this.beforeId) ? this.beforeId : undefined);
  }

  // re-fit the canvas to the view (in Web Mercator, so lng/lat → pixel is linear in x and in mercator-y)
  fit() {
    const c = this.map.getContainer(), W = c.clientWidth, H = c.clientHeight;
    const mW = W * MARGIN, mH = H * MARGIN;
    // screen resolution, but keep the texture re-uploaded every frame under ~4 MP
    const r = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(4e6 / ((W + 2 * mW) * (H + 2 * mH))));
    const tl = this.map.unproject([-mW, -mH]), br = this.map.unproject([W + mW, H + mH]);
    this.west = tl.lng; this.east = br.lng; this.north = tl.lat; this.south = br.lat;
    const prev = this.CW ? { img: this.snapshot(), west: this.westOld, east: this.eastOld, my0: this.my0, my1: this.my1 } : null;
    this.CW = Math.round((W + 2 * mW) * r); this.CH = Math.round((H + 2 * mH) * r);
    this.canvas.width = this.CW; this.canvas.height = this.CH;
    this.pxScale = r;
    this.coords = [[this.west, this.north], [this.east, this.north], [this.east, this.south], [this.west, this.south]];
    this.my0 = this.mercY(this.north); this.my1 = this.mercY(this.south);
    const latMid = (this.north + this.south) / 2;
    this.mPerPx = ((this.east - this.west) * 111320 * Math.cos(latMid * Math.PI / 180)) / this.CW;
    this.westOld = this.west; this.eastOld = this.east;
    // carry the existing trails over (mercator is linear, so it's one drawImage)
    if (prev) {
      const x0 = ((prev.west - this.west) / (this.east - this.west)) * this.CW, x1 = ((prev.east - this.west) / (this.east - this.west)) * this.CW;
      const y0 = ((this.my0 - prev.my0) / (this.my0 - this.my1)) * this.CH, y1 = ((this.my0 - prev.my1) / (this.my0 - this.my1)) * this.CH;
      this.ctx.drawImage(prev.img, x0, y0, x1 - x0, y1 - y0);
    }
    // keep particles that are still in view, top up the rest
    const count = Math.round((W * H) / 700);
    const keep = (this.parts || []).filter(p => p.lng > this.west && p.lng < this.east && p.lat > this.south && p.lat < this.north);
    this.parts = keep.slice(0, count).concat(Array.from({ length: Math.max(0, count - keep.length) }, () => this.spawn(true)));
  }
  snapshot() { const c = document.createElement('canvas'); c.width = this.canvas.width; c.height = this.canvas.height; c.getContext('2d').drawImage(this.canvas, 0, 0); return c; }
  mercY(lat) { const r = lat * Math.PI / 180; return Math.log(Math.tan(Math.PI / 4 + r / 2)); }
  toPx(lng, lat) {
    return [((lng - this.west) / (this.east - this.west)) * this.CW, ((this.my0 - this.mercY(lat)) / (this.my0 - this.my1)) * this.CH];
  }

  nowIndex() {
    const now = Date.now(), ts = this.data.times.map(t => Date.parse(t));
    let best = 0;
    ts.forEach((t, i) => { if (Math.abs(t - now) < Math.abs(ts[best] - now)) best = i; });
    return best;
  }

  // velocity (m/s) at lng/lat: bilinear in space (water cells only), linear in time
  vel(lng, lat) {
    const d = this.data, gx = ((lng - this.gw) * this.gmx) / d.cell - 0.5, gy = ((this.gn - lat) * 110540) / d.cell - 0.5;
    const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
    const t0 = Math.floor(this.t), t1 = Math.min(d.times.length - 1, t0 + 1), ft = this.t - t0;
    let u = 0, v = 0, ws = 0;
    for (const [cx, cy, wt] of [[x0, y0, (1 - fx) * (1 - fy)], [x0 + 1, y0, fx * (1 - fy)], [x0, y0 + 1, (1 - fx) * fy], [x0 + 1, y0 + 1, fx * fy]]) {
      if (cx < 0 || cy < 0 || cx >= d.nx || cy >= d.ny) continue;
      const i = cy * d.nx + cx;
      if (!d.mask[i]) continue;
      u += wt * (d.u[t0][i] * (1 - ft) + d.u[t1][i] * ft);
      v += wt * (d.v[t0][i] * (1 - ft) + d.v[t1][i] * ft);
      ws += wt;
    }
    if (ws < 0.3) return null;
    // exact water mask from our own coastline grid: streaks never cross land
    if (this.isWater && !this.isWater(lng, lat)) return null;
    return [u / ws / 100, v / ws / 100];
  }

  spawn(randomAge = false) {
    for (let tries = 0; tries < 12; tries++) {
      const lng = this.west + Math.random() * (this.east - this.west);
      const lat = this.south + Math.random() * (this.north - this.south);
      const v = this.vel(lng, lat);
      if (!v) continue;
      // slack water gets fewer particles (it reads as clutter, not flow)
      if (Math.random() > 0.3 + 0.7 * Math.min(1, Math.hypot(v[0], v[1]) / 0.35)) continue;
      return { lng, lat, age: randomAge ? (Math.random() * 50) | 0 : 0, life: 50 + ((Math.random() * 50) | 0) };
    }
    return { lng: 0, lat: 0, age: 999, life: 0 }; // over land: retry next frame
  }

  colourFor(sp, a) {
    let c = RAMP[RAMP.length - 1][1];
    for (let i = 1; i < RAMP.length; i++) if (sp <= RAMP[i][0]) {
      const [s0, c0] = RAMP[i - 1], [s1, c1] = RAMP[i], f = (sp - s0) / (s1 - s0);
      c = c0.map((v, k) => Math.round(v + (c1[k] - v) * f)); break;
    }
    return `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`;
  }

  step() {
    const ctx = this.ctx, r = this.pxScale;
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'rgba(0,0,0,0.93)';
    ctx.fillRect(0, 0, this.CW, this.CH);
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'butt'; // round caps overlap at every joint and make beads
    // real-speed motion, but eased once you zoom in past 13.5 so it doesn't go to warp speed
    const z = this.map.getZoom();
    const mPerFrame = (SPEEDUP / FPS) * (z > 13.5 ? Math.pow(2, -(z - 13.5) * 0.7) : 1);
    for (const p of this.parts) {
      const vel = p.age <= p.life && this.vel(p.lng, p.lat);
      if (!vel) { Object.assign(p, this.spawn()); continue; }
      p.age++;
      const sp = Math.hypot(vel[0], vel[1]);
      // visual speed ∝ speed^0.45: slow shallows still drift visibly, channels stay clearly faster
      const vis = sp > 1e-4 ? (1.2 * Math.pow(sp / 1.2, 0.45)) / sp : 0;
      const dE = vel[0] * vis * mPerFrame, dN = vel[1] * vis * mPerFrame;
      const lng2 = p.lng + dE / (111320 * Math.cos(p.lat * Math.PI / 180)), lat2 = p.lat + dN / 110540;
      const [x1, y1] = this.toPx(p.lng, p.lat), [x2, y2] = this.toPx(lng2, lat2);
      const life = Math.min(1, p.age / 8, (p.life - p.age) / 8);
      const strength = Math.min(1, Math.sqrt(sp / 1.2));
      const width = (1.1 + 0.7 * strength) * r;
      ctx.strokeStyle = this.colour ? this.colourFor(sp, life * 0.85)
        : `rgba(255,255,255,${(life * (0.65 + 0.35 * strength)).toFixed(3)})`;
      ctx.lineWidth = width;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      p.lng = lng2; p.lat = lat2;
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    let last = 0;
    const loop = (ts) => {
      if (!this.running) return;
      if (ts - last >= 1000 / FPS) { this.step(); last = ts; }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() { this.running = false; cancelAnimationFrame(this.raf); }
  setTime(t) { this.t = t; this.onTime?.(t); }
  setColour(on) { this.colour = on; }
  setVisible(on) {
    this.visible = on;
    if (this.map.getLayer('flow')) this.map.setLayoutProperty('flow', 'visibility', on ? 'visible' : 'none');
    if (on) this.start(); else this.stop();
  }
}

export function timeLabel(data, t) {
  const i = Math.round(t), d = new Date(data.times[i]);
  const s = d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return `${s} · ${i < data.nowcast ? 'model nowcast' : 'forecast'}`;
}
