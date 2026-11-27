// Animated surface currents from NOAA SFBOFS (scripts/fetch-sfbofs.py).
// A living background: streaks drifting with the water. Strength shows as motion
// (faster, longer streaks); "colour by speed" tints the water itself by current speed.
//
// The streaks are drawn *in the map*: a canvas that covers the current view (plus a
// margin) at screen resolution, given to MapLibre as a canvas source + raster layer.
// So it sits in the style's stacking order (under labels and buoys), stays crisp, and
// moves with the map while panning; after each pan/zoom it re-fits to the new view.
// Particles live in lng/lat and move at a fixed multiple of the real current.

const FPS = 30;
const MARGIN = 0.1;      // canvas reaches 10% beyond the view on each side
// background "colour by speed" ramp (m/s → colour), PredictWind-style but softer
const RAMP = [[0, [207, 230, 239]], [0.25, [159, 208, 224]], [0.5, [124, 196, 176]], [0.8, [232, 210, 122]], [1.2, [237, 161, 94]], [1.6, [217, 103, 76]]];

// every look-and-feel knob in one place; the tuning panel edits these live
export const DEFAULTS = {
  // tuned by Greg 2026-11-17 (v4): fine, opaque streaks with longer trails, on slightly toned water
  density: 3,       // particles per 1000 px² of screen at zoom 13.5
  zoomedOut: 0.65,   // how fast density thins as you zoom out (0 = no thinning)
  speed: 380,       // streaks move this many times faster than the water
  zoomEase: 0.85,   // past zoom 13.5, how much to damp the real-speed increase (0 = none, 1 = constant on screen)
  compress: 0.65,   // visual speed ∝ speed^compress (lower = slow water moves more)
  trail: 0.915,     // per-frame trail fade (higher = longer streaks)
  opacity: 2,       // overall streak opacity (multiplier; capped at fully opaque)
  width: 0.6,       // overall streak width (multiplier)
  life: 80,         // average particle life in frames (too long and particles bunch into 'tide lines')
};

export class FlowLayer {
  constructor(map, data, { onTime, beforeId, speedBeforeId, isWater, params } = {}) {
    Object.assign(this, { map, data, onTime, beforeId, speedBeforeId, isWater });
    this.p = { ...DEFAULTS, ...(params || {}) };
    // compact files list values only for water cells: expand to full grids once
    if (data.water) {
      const n = data.nx * data.ny, idx = data.water;
      data.mask = new Uint8Array(n); idx.forEach(i => (data.mask[i] = 1));
      const full = (rows) => rows.map(r => { const a = new Int16Array(n); r.forEach((v, k) => (a[idx[k]] = v)); return a; });
      data.u = full(data.u); data.v = full(data.v);
    }
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
    // the speed-coloured water (used instead of the depth tint when "Colour by speed" is on)
    map.addSource('flow-speed', { type: 'image', url: this.speedImage(), coordinates: this.gridCoords() });
    map.addLayer({ id: 'flow-speed', type: 'raster', source: 'flow-speed',
      layout: { visibility: this.colour ? 'visible' : 'none' },
      paint: { 'raster-fade-duration': 0, 'raster-resampling': 'linear', 'raster-opacity': 0.9 } },
      map.getLayer(this.speedBeforeId) ? this.speedBeforeId : undefined);
    if (map.getLayer('depth')) map.setLayoutProperty('depth', 'visibility', this.colour ? 'none' : 'visible');
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
    const z = this.map.getZoom(), thin = z < 13.5 ? Math.pow(2, (z - 13.5) * this.p.zoomedOut) : 1;
    const count = Math.round(((W * H) / 1000) * this.p.density * thin);
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
      const life = Math.round(this.p.life * (0.65 + 0.7 * Math.random()));
      return { lng, lat, age: randomAge ? (Math.random() * life) | 0 : 0, life };
    }
    return { lng: 0, lat: 0, age: 999, life: 0 }; // over land: retry next frame
  }

  step() {
    const ctx = this.ctx, r = this.pxScale;
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = `rgba(0,0,0,${this.p.trail})`;
    ctx.fillRect(0, 0, this.CW, this.CH);
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'butt'; // round caps overlap at every joint and make beads
    // real-speed motion, but eased once you zoom in past 13.5 so it doesn't go to warp speed
    const z = this.map.getZoom();
    const mPerFrame = (this.p.speed / FPS) * (z > 13.5 ? Math.pow(2, -(z - 13.5) * this.p.zoomEase) : 1);
    for (const p of this.parts) {
      const vel = p.age <= p.life && this.vel(p.lng, p.lat);
      if (!vel) { Object.assign(p, this.spawn()); continue; }
      p.age++;
      const sp = Math.hypot(vel[0], vel[1]);
      // visual speed ∝ speed^0.45: slow shallows still drift visibly, channels stay clearly faster
      const vis = sp > 1e-4 ? (1.2 * Math.pow(sp / 1.2, this.p.compress)) / sp : 0;
      const dE = vel[0] * vis * mPerFrame, dN = vel[1] * vis * mPerFrame;
      const lng2 = p.lng + dE / (111320 * Math.cos(p.lat * Math.PI / 180)), lat2 = p.lat + dN / 110540;
      const [x1, y1] = this.toPx(p.lng, p.lat), [x2, y2] = this.toPx(lng2, lat2);
      const life = Math.min(1, p.age / 8, (p.life - p.age) / 8);
      const strength = Math.min(1, Math.sqrt(sp / 1.2));
      const width = (1.1 + 0.7 * strength) * r * this.p.width;
      ctx.strokeStyle = `rgba(255,255,255,${Math.min(1, life * (0.65 + 0.35 * strength) * this.p.opacity).toFixed(3)})`;
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
  setTime(t) {
    this.t = t; this.onTime?.(t);
    if (this.colour) { clearTimeout(this.sT); this.sT = setTimeout(() => this.map.getSource('flow-speed')?.updateImage({ url: this.speedImage(), coordinates: this.gridCoords() }), 30); }
  }
  setColour(on) {
    this.colour = on;
    if (on) this.map.getSource('flow-speed')?.updateImage({ url: this.speedImage(), coordinates: this.gridCoords() });
    if (this.map.getLayer('flow-speed')) this.map.setLayoutProperty('flow-speed', 'visibility', on ? 'visible' : 'none');
    if (this.map.getLayer('depth')) this.map.setLayoutProperty('depth', 'visibility', on ? 'none' : 'visible');
  }
  setParams(patch) { Object.assign(this.p, patch); if ('density' in patch || 'zoomedOut' in patch || 'life' in patch) this.fit(); }

  // corners of the current grid, for the speed image
  gridCoords() {
    const d = this.data, wM = d.nx * d.cell, hM = d.ny * d.cell;
    const e = this.gw + wM / this.gmx, s = this.gn - hM / 110540;
    return [[this.gw, this.gn], [e, this.gn], [e, s], [this.gw, s]];
  }
  // one pixel per grid cell, coloured by speed at the current time; land transparent
  speedImage() {
    const d = this.data, c = document.createElement('canvas'); c.width = d.nx; c.height = d.ny;
    const ctx = c.getContext('2d'), img = ctx.createImageData(d.nx, d.ny);
    const t0 = Math.floor(this.t), t1 = Math.min(d.times.length - 1, t0 + 1), ft = this.t - t0;
    for (let y = 0; y < d.ny; y++) for (let x = 0; x < d.nx; x++) {
      const i = y * d.nx + x;
      const lng = this.gw + ((x + 0.5) * d.cell) / this.gmx, lat = this.gn - ((y + 0.5) * d.cell) / 110540;
      if (!d.mask[i] || (this.isWater && !this.isWater(lng, lat))) continue;
      const u = (d.u[t0][i] * (1 - ft) + d.u[t1][i] * ft) / 100, v = (d.v[t0][i] * (1 - ft) + d.v[t1][i] * ft) / 100;
      const col = this.rampColour(Math.hypot(u, v));
      img.data.set([col[0], col[1], col[2], 255], i * 4);
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL();
  }
  rampColour(sp) {
    for (let i = 1; i < RAMP.length; i++) if (sp <= RAMP[i][0]) {
      const [s0, c0] = RAMP[i - 1], [s1, c1] = RAMP[i], f = (sp - s0) / (s1 - s0);
      return c0.map((v, k) => Math.round(v + (c1[k] - v) * f));
    }
    return RAMP[RAMP.length - 1][1];
  }
  setVisible(on) {
    this.visible = on;
    if (this.map.getLayer('flow')) this.map.setLayoutProperty('flow', 'visibility', on ? 'visible' : 'none');
    if (on) this.start(); else this.stop();
  }
}

export function timeLabel(data, t) {
  const i = Math.round(t), d = new Date(data.times[i]);
  const s = d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return `<b>${s}</b><small>${i < data.nowcast ? 'model nowcast' : 'NOAA forecast'}</small>`;
}
