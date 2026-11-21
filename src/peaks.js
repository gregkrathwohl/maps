// Summit labels that keep off the trails: for each named peak, try the label on each side of its summit mark
// (right, left, below, above, then the diagonals) and keep the side where the fewest trail/road pixels run
// under the text. Worked out once, at the paper design zoom, where the sheet's proportions are fixed: in paper
// mode text and lines scale together, so the best side there is the best side at every zoom.
// Writes properties._anchor (a MapLibre text-anchor) on each peak feature.

export const PEAK_SIZE = 11;   // px at the design zoom (style.js peak-label T(11))
const OPTIONS = [   // [text-anchor, preference penalty]
  ['left', 0], ['right', 2], ['top', 4], ['bottom', 4], ['top-left', 8], ['bottom-left', 8], ['top-right', 10], ['bottom-right', 10]];
// text-offset (ems) per anchor: clear of the triangle
export const OFFSETS = { left: [0.8, 0], right: [-0.8, 0], top: [0, 0.7], bottom: [0, -0.8],
  'top-left': [0.55, 0.45], 'bottom-left': [0.55, -0.55], 'top-right': [-0.55, 0.45], 'bottom-right': [-0.55, -0.55] };

// length of segment a-b inside the box (Liang-Barsky)
function clipLen(ax, ay, bx, by, x0, y0, x1, y1) {
  let t0 = 0, t1 = 1; const dx = bx - ax, dy = by - ay;
  for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]) {
    if (p === 0) { if (q < 0) return 0; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return 0; if (t > t0) t0 = t; } else { if (t < t0) return 0; if (t < t1) t1 = t; }
  }
  return (t1 - t0) * Math.hypot(dx, dy);
}

function wrap(name, s) {   // roughly MapLibre's text-max-width: 5 (ems)
  const max = 5 * s, cw = 0.56 * s, lines = [];
  let cur = '';
  for (const w of name.split(/\s+/)) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && next.length * cw > max) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  return { w: Math.max(...lines.map(l => l.length)) * cw, h: lines.length * 1.2 * s };
}

export function placePeaks(features, designZoom) {
  const world = 512 * 2 ** designZoom;
  const X = (lng) => (lng + 180) / 360 * world;
  const Y = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2 * world;
  const peaks = features.filter(f => f.properties.natural === 'peak' && f.properties.name && f.geometry.type === 'Point');
  if (!peaks.length) return;
  // a grid of every road/trail segment near a peak
  const CELL = 64, grid = new Map(), key = (i, j) => `${i},${j}`;
  const near = new Set(peaks.map(f => key(Math.floor(X(f.geometry.coordinates[0]) / CELL), Math.floor(Y(f.geometry.coordinates[1]) / CELL))));
  const isNear = (x, y) => { const i = Math.floor(x / CELL), j = Math.floor(y / CELL);
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) if (near.has(key(i + a, j + b))) return true; return false; };
  for (const f of features) {
    if (f.geometry.type !== 'LineString' || !f.properties.highway) continue;
    const pts = f.geometry.coordinates.map(([lng, lat]) => [X(lng), Y(lat)]);
    for (let k = 1; k < pts.length; k++) {
      const [ax, ay] = pts[k - 1], [bx, by] = pts[k];
      if (!isNear(ax, ay) && !isNear(bx, by)) continue;
      const seg = [ax, ay, bx, by];
      for (let i = Math.floor(Math.min(ax, bx) / CELL); i <= Math.floor(Math.max(ax, bx) / CELL); i++)
        for (let j = Math.floor(Math.min(ay, by) / CELL); j <= Math.floor(Math.max(ay, by) / CELL); j++) {
          const kk = key(i, j); if (!grid.has(kk)) grid.set(kk, []); grid.get(kk).push(seg);
        }
    }
  }
  const s = PEAK_SIZE;
  for (const f of peaks) {
    const px = X(f.geometry.coordinates[0]), py = Y(f.geometry.coordinates[1]), { w, h } = wrap(f.properties.name, s);
    let best = 'left', bestScore = Infinity;
    for (const [a, pen] of OPTIONS) {
      const [ox, oy] = OFFSETS[a].map(v => v * s);
      const x0 = px + ox - (a.includes('left') ? 0 : a.includes('right') ? w : w / 2);
      const y0 = py + oy - (a.startsWith('top') ? 0 : a.startsWith('bottom') ? h : h / 2);
      const x1 = x0 + w, y1 = y0 + h, seen = new Set();
      let len = 0;
      for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++)
        for (let j = Math.floor(y0 / CELL); j <= Math.floor(y1 / CELL); j++)
          for (const sg of grid.get(key(i, j)) || []) { if (seen.has(sg)) continue; seen.add(sg); len += clipLen(...sg, x0, y0, x1, y1); }
      const score = len + pen;
      if (score < bestScore) { bestScore = score; best = a; }
    }
    f.properties._anchor = best;
  }
}
