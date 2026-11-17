// Turn rough current descriptions into "wispy" flow lines.
// Each current's centre line is the channel thalweg (deepest line), found by
// sampling Terrarium DEM tiles across the channel at regular steps: tidal
// currents run strongest along the deep channels.
// usage: node scripts/currents.mjs <place>  → places/<place>/data/currents.geojson
import fs from 'node:fs';
import { PNG } from 'pngjs';

const place = process.argv[2] || 'richardson-bay';
const defs = JSON.parse(fs.readFileSync(`places/${place}/currents.json`, 'utf8'));
const Z = 14;

// --- DEM sampling (Terrarium encoding)
const tiles = new Map();
async function tile(x, y) {
  const k = `${x}/${y}`;
  if (!tiles.has(k)) {
    const r = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${x}/${y}.png`);
    tiles.set(k, PNG.sync.read(Buffer.from(await r.arrayBuffer())));
  }
  return tiles.get(k);
}
async function elev(lon, lat) {
  const n = 2 ** Z;
  const fx = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  const png = await tile(Math.floor(fx), Math.floor(fy));
  const px = Math.floor((fx % 1) * 256), py = Math.floor((fy % 1) * 256);
  const i = (py * 256 + px) * 4;
  return png.data[i] * 256 + png.data[i + 1] + png.data[i + 2] / 256 - 32768;
}

// --- thalweg: deepest point on each transect, then smoothed
async function thalweg(d) {
  const pts = [];
  for (let a = d.from; d.from < d.to ? a <= d.to : a >= d.to; a += d.step * Math.sign(d.to - d.from)) {
    let best = null;
    for (let b = d.window[0]; b <= d.window[1]; b += 0.0003) {
      const [lon, lat] = d.axis === 'lon' ? [a, b] : [b, a];
      const e = await elev(lon, lat);
      if (!best || e < best.e) best = { lon, lat, e };
    }
    if (best.e < -2) pts.push([best.lon, best.lat]);
  }
  for (let pass = 0; pass < 4; pass++) // light smoothing
    for (let i = 1; i < pts.length - 1; i++)
      pts[i] = [0, 1].map(k => (pts[i - 1][k] + 2 * pts[i][k] + pts[i + 1][k]) / 4);
  return pts;
}

// --- wisps: broken, gently waving strands either side of the centre line
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
function wisps(line, strength, name) {
  const lat0 = line[0][1] * Math.PI / 180, mx = 111320 * Math.cos(lat0), my = 110540;
  const P = line.map(([x, y]) => [x * mx, y * my]);
  // resample every 15 m
  const S = [P[0]];
  for (let i = 1; i < P.length; i++) {
    const [ax, ay] = P[i - 1], [bx, by] = P[i], L = Math.hypot(bx - ax, by - ay);
    for (let t = 15; t <= L; t += 15) S.push([ax + (bx - ax) * t / L, ay + (by - ay) * t / L]);
  }
  const N = S.map((p, i) => { const a = S[Math.max(0, i - 2)], b = S[Math.min(S.length - 1, i + 2)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [-dy / l, dx / l]; });
  const strands = 3 + strength * 3, half = 60 + strength * 70, out = [];
  for (let j = 0; j < strands; j++) {
    const off = (j / (strands - 1) - 0.5) * 2 * half * (0.8 + 0.4 * rnd());
    const edge = Math.abs(off) / half; // outer strands are fainter and shorter
    const phase = rnd() * 6.28, wl = 500 + rnd() * 500, amp = 8 + rnd() * 14;
    let i = Math.floor(rnd() * 20);
    while (i < S.length - 3) {
      const len = Math.floor((15 + rnd() * 30) * (1 - 0.5 * edge) * (0.6 + 0.2 * strength));
      const seg = [];
      for (let k = i; k < Math.min(S.length, i + len); k++) {
        const s = k * 15, o = off + amp * Math.sin(2 * Math.PI * s / wl + phase);
        seg.push([+((S[k][0] + N[k][0] * o) / mx).toFixed(6), +((S[k][1] + N[k][1] * o) / my).toFixed(6)]);
      }
      if (seg.length > 3) out.push({ type: 'Feature', properties: { name, strength, edge: +edge.toFixed(2) },
        geometry: { type: 'LineString', coordinates: seg } });
      i += len + Math.floor(5 + rnd() * 25);
    }
  }
  return out;
}

const features = [];
for (const d of defs) {
  const line = await thalweg(d);
  features.push({ type: 'Feature', properties: { name: d.name, strength: d.strength, centre: true },
    geometry: { type: 'LineString', coordinates: line } });
  features.push(...wisps(line, d.strength, d.name));
  console.log(d.name, line.length, 'pts');
}
fs.mkdirSync(`places/${place}/data`, { recursive: true });
fs.writeFileSync(`places/${place}/data/currents.geojson`, JSON.stringify({ type: 'FeatureCollection', features }));
console.log('wrote', features.length, 'features');
