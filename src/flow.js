// Animated surface currents from NOAA SFBOFS (scripts/fetch-sfbofs.py).
// A living background: pale streaks drifting with the water, strength shown as
// motion (speed and length), never colour. Paused, the last frame stays as a still pattern.
//
// The streaks live *in the map*: particles move in map coordinates and are drawn
// into a canvas that MapLibre stretches over the bay as a canvas source + raster layer.
// So the layer sits in the style's stacking order (under labels and buoys), pans and
// zooms with the map without flashing, and moves at a fixed multiple of the real current:
// slow when zoomed out, faster when zoomed in, like the water itself.

const SPEEDUP = 220;   // streaks move ~220× real time (after the √ compression below)
const FPS = 30;

export class FlowLayer {
  constructor(map, data, { onTime, beforeId } = {}) {
    Object.assign(this, { map, data, onTime, beforeId });
    const [w, , , n] = data.bbox;
    const lat0 = ((data.bbox[1] + data.bbox[3]) / 2) * Math.PI / 180;
    this.mx = 111320 * Math.cos(lat0); this.my = 110540;
    const widthM = data.nx * data.cell, heightM = data.ny * data.cell;
    this.CW = 2048; this.CH = Math.round(this.CW * heightM / widthM);
    this.mPerPx = widthM / this.CW;
    this.coords = [[w, n], [w + widthM / this.mx, n], [w + widthM / this.mx, n - heightM / this.my], [w, n - heightM / this.my]];
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.CW; this.canvas.height = this.CH;
    this.ctx = this.canvas.getContext('2d');
    this.water = []; data.mask.forEach((m, i) => m && this.water.push(i));
    this.parts = Array.from({ length: 1400 }, () => this.spawn(true));
    this.t = this.nowIndex();
    this.playing = false; this.visible = true;
    this.attach();
    map.on('style.load', () => this.attach());
  }

  attach() {
    const { map } = this;
    if (!map.isStyleLoaded() && !map.getStyle()) return;
    if (map.getSource('flow')) return;
    map.addSource('flow', { type: 'canvas', canvas: this.canvas, coordinates: this.coords, animate: true });
    map.addLayer({ id: 'flow', type: 'raster', source: 'flow',
      layout: { visibility: this.visible ? 'visible' : 'none' },
      paint: { 'raster-fade-duration': 0, 'raster-resampling': 'linear' } },
      map.getLayer(this.beforeId) ? this.beforeId : undefined);
    if (!this.playing) map.getSource('flow').pause?.();
  }

  nowIndex() {
    const now = Date.now(), ts = this.data.times.map(t => Date.parse(t));
    let best = 0;
    ts.forEach((t, i) => { if (Math.abs(t - now) < Math.abs(ts[best] - now)) best = i; });
    return best;
  }

  // velocity (m/s) at canvas pixel (x, y), bilinear in space and linear in time
  vel(x, y) {
    const d = this.data, gx = (x * this.mPerPx) / d.cell - 0.5, gy = (y * this.mPerPx) / d.cell - 0.5;
    const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
    const t0 = Math.floor(this.t), t1 = Math.min(d.times.length - 1, t0 + 1), ft = this.t - t0;
    let u = 0, v = 0, wsum = 0;
    for (const [cx, cy, wt] of [[x0, y0, (1 - fx) * (1 - fy)], [x0 + 1, y0, fx * (1 - fy)], [x0, y0 + 1, (1 - fx) * fy], [x0 + 1, y0 + 1, fx * fy]]) {
      if (cx < 0 || cy < 0 || cx >= d.nx || cy >= d.ny) continue;
      const i = cy * d.nx + cx;
      if (!d.mask[i]) continue;
      u += wt * (d.u[t0][i] * (1 - ft) + d.u[t1][i] * ft);
      v += wt * (d.v[t0][i] * (1 - ft) + d.v[t1][i] * ft);
      wsum += wt;
    }
    if (wsum < 0.3) return null; // mostly land
    return [u / wsum / 100, v / wsum / 100];
  }

  // spawn anywhere on water, evenly by area
  spawn(randomAge = false) {
    const d = this.data, i = this.water[(Math.random() * this.water.length) | 0];
    const cellPx = d.cell / this.mPerPx;
    return { x: ((i % d.nx) + Math.random()) * cellPx, y: (((i / d.nx) | 0) + Math.random()) * cellPx,
      age: randomAge ? (Math.random() * 60) | 0 : 0, life: 40 + ((Math.random() * 40) | 0) };
  }

  step() {
    const ctx = this.ctx, k = (SPEEDUP / FPS) / this.mPerPx; // canvas px per frame per m/s
    ctx.globalCompositeOperation = 'destination-in';     // fade trails → short streaks
    ctx.fillStyle = 'rgba(0,0,0,0.92)';
    ctx.fillRect(0, 0, this.CW, this.CH);
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
    for (const p of this.parts) {
      const vel = this.vel(p.x, p.y);
      if (!vel || ++p.age > p.life) { Object.assign(p, this.spawn()); continue; }
      const sp = Math.hypot(vel[0], vel[1]);
      // compress the range: visual speed ∝ √speed, so 0.1 m/s shallows still drift visibly
      // while the 1+ m/s channels stay clearly faster and longer
      const vis = sp > 1e-4 ? Math.sqrt(sp / 1.2) * 1.2 / sp : 0;
      const nx = p.x + vel[0] * vis * k, ny = p.y - vel[1] * vis * k;
      // fade in and out over a particle's life; weak water still visible (sqrt lifts the slow end)
      const life = Math.min(1, p.age / 8, (p.life - p.age) / 8);
      const a = life * (0.35 + 0.45 * Math.min(1, Math.sqrt(sp / 1.2)));
      ctx.strokeStyle = `rgba(255,255,255,${a.toFixed(3)})`;
      ctx.lineWidth = 1.1 + 0.6 * Math.min(1, sp / 1.2);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(nx + 0.01, ny); ctx.stroke();
      p.x = nx; p.y = ny;
    }
  }

  // frozen frame with trails: run the flow briefly without showing every step
  still() { this.ctx.clearRect(0, 0, this.CW, this.CH); for (let s = 0; s < 30; s++) this.step(); this.map.triggerRepaint(); this.map.getSource('flow')?.play?.(); setTimeout(() => { if (!this.playing) this.map.getSource('flow')?.pause?.(); }, 100); }

  play() {
    if (this.playing) return;
    this.playing = true;
    this.map.getSource('flow')?.play?.();
    let last = 0;
    const loop = (ts) => {
      if (!this.playing) return;
      if (ts - last >= 1000 / FPS) { this.step(); last = ts; }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  pause() { this.playing = false; cancelAnimationFrame(this.raf); this.map.getSource('flow')?.pause?.(); }
  setTime(t) { this.t = t; this.onTime?.(t); if (!this.playing) this.still(); }
  setVisible(on) {
    this.visible = on;
    if (this.map.getLayer('flow')) this.map.setLayoutProperty('flow', 'visibility', on ? 'visible' : 'none');
    if (!on) this.pause();
  }
}

export function timeLabel(data, t) {
  const i = Math.round(t), d = new Date(data.times[i]);
  const s = d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return `${s} · ${i < data.nowcast ? 'model nowcast' : 'forecast'}`;
}
