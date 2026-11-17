// Animated surface currents from NOAA SFBOFS (scripts/fetch-sfbofs.py).
// A living background: pale streaks drifting with the water. Strength shows as
// motion (faster, longer, a little brighter streaks), never as colour.
// Paused, the last frame stays as a still pattern, part of the chart.

export class FlowLayer {
  constructor(map, data, { onTime } = {}) {
    Object.assign(this, { map, data, onTime });
    const [w, , , n] = data.bbox;
    this.w = w; this.n = n;
    this.mx = 111320 * Math.cos(((data.bbox[1] + data.bbox[3]) / 2) * Math.PI / 180);
    this.my = 110540;
    this.t = this.nowIndex();
    this.playing = false;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'flow-canvas';
    map.getCanvasContainer().appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.resize();
    map.on('resize', () => this.resize());
    map.on('movestart', () => this.clear());
    map.on('moveend', () => { this.seed(); if (!this.playing) this.still(); });
    this.seed();
    this.visible = true;
  }

  nowIndex() {
    const now = Date.now(), ts = this.data.times.map(t => Date.parse(t));
    let best = 0;
    ts.forEach((t, i) => { if (Math.abs(t - now) < Math.abs(ts[best] - now)) best = i; });
    return best;
  }

  resize() {
    const r = window.devicePixelRatio || 1, c = this.map.getContainer();
    this.W = c.clientWidth; this.H = c.clientHeight;
    this.canvas.width = this.W * r; this.canvas.height = this.H * r;
    this.canvas.style.width = `${this.W}px`; this.canvas.style.height = `${this.H}px`;
    this.ctx.setTransform(r, 0, 0, r, 0, 0);
    this.seed();
  }

  // velocity (m/s) at a lng/lat for fractional time index t; null on land / outside
  vel(lng, lat, t = this.t) {
    const d = this.data, gx = ((lng - this.w) * this.mx) / d.cell - 0.5, gy = ((this.n - lat) * this.my) / d.cell - 0.5;
    const x = Math.round(gx), y = Math.round(gy);
    if (x < 0 || y < 0 || x >= d.nx || y >= d.ny) return null;
    const i = y * d.nx + x;
    if (!d.mask[i]) return null;
    const t0 = Math.floor(t), t1 = Math.min(d.times.length - 1, t0 + 1), f = t - t0;
    const u = (d.u[t0][i] * (1 - f) + d.u[t1][i] * f) / 100, v = (d.v[t0][i] * (1 - f) + d.v[t1][i] * f) / 100;
    return [u, v];
  }

  seed() {
    const count = Math.round((this.W * this.H) / 900);
    this.parts = Array.from({ length: count }, () => this.spawn());
  }
  spawn() { return { x: Math.random() * this.W, y: Math.random() * this.H, age: Math.floor(Math.random() * 80) }; }

  clear() { this.ctx.clearRect(0, 0, this.W, this.H); }

  step() {
    const ctx = this.ctx;
    // fade old trails
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'rgba(0,0,0,0.93)';
    ctx.fillRect(0, 0, this.W, this.H);
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
    const pxPerMs = 3.2; // screen px per frame for 1 m/s
    for (const p of this.parts) {
      const ll = this.map.unproject([p.x, p.y]);
      const vel = this.vel(ll.lng, ll.lat);
      if (!vel || p.age++ > 90) { Object.assign(p, this.spawn(), { age: 0 }); continue; }
      const sp = Math.hypot(vel[0], vel[1]);
      const nx = p.x + vel[0] * pxPerMs, ny = p.y - vel[1] * pxPerMs;
      ctx.strokeStyle = `rgba(255,255,255,${(0.18 + 0.62 * Math.min(1, sp / 1.2)).toFixed(3)})`;
      ctx.lineWidth = 0.8 + 0.9 * Math.min(1, sp / 1.2);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny); ctx.stroke();
      p.x = nx; p.y = ny;
    }
  }

  // a frozen frame: run the flow briefly so the still shows trails
  still() { this.clear(); for (let k = 0; k < 40; k++) this.step(); }

  play() { if (this.playing) return; this.playing = true; const loop = () => { if (!this.playing) return; this.step(); this.raf = requestAnimationFrame(loop); }; loop(); }
  pause() { this.playing = false; cancelAnimationFrame(this.raf); }
  setTime(t) { this.t = t; this.onTime?.(t); if (!this.playing) this.still(); }
  setVisible(on) { this.visible = on; this.canvas.style.display = on ? '' : 'none'; if (!on) this.pause(); else if (!this.playing) this.still(); }
}

export function timeLabel(data, t) {
  const i = Math.round(t), d = new Date(data.times[i]);
  const s = d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return `${s} · ${i < data.nowcast ? 'model nowcast' : 'forecast'}`;
}
