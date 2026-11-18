// Fill patterns and icons drawn on a canvas, so the style needs no sprite sheet.
const R = 2; // pixel ratio

function canvas(w, h, draw) {
  const el = document.createElement('canvas');
  el.width = w * R; el.height = h * R;
  const ctx = el.getContext('2d');
  ctx.scale(R, R);
  draw(ctx);
  return { width: el.width, height: el.height, data: new Uint8Array(ctx.getImageData(0, 0, el.width, el.height).data.buffer) };
}

export function addImages(map, c) {
  // salt-marsh tufts: little three-stroke fans, staggered
  map.addImage('marsh', canvas(28, 18, ctx => {
    ctx.strokeStyle = c.marsh; ctx.lineWidth = 0.6; ctx.lineCap = 'round';
    for (const [x, y] of [[6, 7], [20, 16]]) {
      ctx.beginPath(); ctx.moveTo(x - 3, y); ctx.lineTo(x + 3, y); ctx.stroke();
      for (const dx of [-1.6, 0, 1.6]) { ctx.beginPath(); ctx.moveTo(x + dx * 0.4, y - 0.4); ctx.lineTo(x + dx, y - 3); ctx.stroke(); }
    }
  }), { pixelRatio: R });

  // beach stipple: offset dots
  map.addImage('stipple', canvas(8, 8, ctx => {
    ctx.fillStyle = c.beachDot;
    for (const [x, y] of [[2, 2], [6, 6]]) { ctx.beginPath(); ctx.arc(x, y, 0.65, 0, Math.PI * 2); ctx.fill(); }
  }), { pixelRatio: R });

  // launch: dark green disc with a little kayak and paddle
  map.addImage('kayak', canvas(36, 36, ctx => {
    ctx.fillStyle = '#366f53'; ctx.beginPath(); ctx.arc(18, 18, 16, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6; ctx.fillStyle = '#fff';
    ctx.save(); ctx.translate(18, 18); ctx.rotate(-0.5);
    ctx.beginPath(); ctx.ellipse(0, 0, 11, 3.2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.rotate(1.2); ctx.beginPath(); ctx.moveTo(-11, 0); ctx.lineTo(11, 0); ctx.stroke();
    for (const x of [-11, 11]) { ctx.beginPath(); ctx.ellipse(x, 0, 2.6, 1.4, 0, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }), { pixelRatio: R });

  // water: short hand-drawn wave strokes, staggered, like an engraver's sea
  if (!map.hasImage('waves')) map.addImage('waves', canvas(46, 22, ctx => {
    ctx.strokeStyle = 'rgba(70,125,165,0.55)'; ctx.lineWidth = 0.7; ctx.lineCap = 'round';
    const wave = (x, y, w) => { ctx.beginPath(); ctx.moveTo(x, y);
      ctx.bezierCurveTo(x + w * 0.25, y - 1.6, x + w * 0.5, y - 1.6, x + w * 0.5, y);
      ctx.bezierCurveTo(x + w * 0.5, y + 1.4, x + w * 0.75, y + 1.4, x + w, y); ctx.stroke(); };
    wave(4, 6, 12); wave(27, 17, 11);
  }), { pixelRatio: R });

  // water bumps: a seamless, softly lit "lumpy" sea, the same trick as the painted canopy
  // (noise height field → light from the NW), drawn as pale highlights and blue shadows
  if (!map.hasImage('water-bumps')) {
    const S = 192 * R, rnd = mulberry(7);
    const octave = (n) => { const g = Array.from({ length: n * n }, () => rnd());
      return (x, y) => { const fx = x / S * n, fy = y / S * n, x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = fx - x0, ty = fy - y0, s = (t) => t * t * (3 - 2 * t);
        const v = (i, j) => g[((j % n + n) % n) * n + ((i % n + n) % n)];
        const a = v(x0, y0) + (v(x0 + 1, y0) - v(x0, y0)) * s(tx), b = v(x0, y0 + 1) + (v(x0 + 1, y0 + 1) - v(x0, y0 + 1)) * s(tx);
        return a + (b - a) * s(ty); }; };
    const o1 = octave(8), o2 = octave(16), o3 = octave(32);
    const h = new Float32Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) h[y * S + x] = o1(x, y) * 0.55 + o2(x, y) * 0.3 + o3(x, y) * 0.15;
    const el = document.createElement('canvas'); el.width = el.height = S;
    const ctx = el.getContext('2d'), img = ctx.createImageData(S, S);
    const H = (x, y) => h[((y + S) % S) * S + ((x + S) % S)];
    const L = [-0.6, -0.6, 0.53];
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const nx = (H(x - 1, y) - H(x + 1, y)) * 9, ny = (H(x, y - 1) - H(x, y + 1)) * 9;
      const lam = (nx * L[0] + ny * L[1] + L[2]) / Math.hypot(nx, ny, 1) - L[2];   // 0 = flat
      const i = (y * S + x) * 4;
      if (lam > 0) { img.data.set([255, 255, 255, Math.min(255, lam * 210)], i); }
      else { img.data.set([40, 95, 140, Math.min(255, -lam * 170)], i); }
    }
    ctx.putImageData(img, 0, 0);
    map.addImage('water-bumps', { width: S, height: S, data: new Uint8Array(ctx.getImageData(0, 0, S, S).data.buffer) }, { pixelRatio: R });
  }

  // peak: open triangle (NPS style)
  if (!map.hasImage('peak-tri')) map.addImage('peak-tri', canvas(24, 22, ctx => {
    ctx.strokeStyle = '#4a4a4a'; ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(12, 3); ctx.lineTo(21, 19); ctx.lineTo(3, 19); ctx.closePath(); ctx.stroke();
  }), { pixelRatio: R });

  // trailhead parking: black rounded square, white P
  map.addImage('parking', canvas(36, 36, ctx => {
    ctx.fillStyle = '#111';
    ctx.beginPath(); ctx.roundRect(2, 2, 32, 32, 6); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 25px Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('P', 18, 19.5);
  }), { pixelRatio: R });
}

// small seeded random generator, so the texture is the same on every load
function mulberry(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
