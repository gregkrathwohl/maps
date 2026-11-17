// Join OSM coastline pieces into continuous lines and smooth them, so the
// coast and the waterline ripples (drawn with line-offset) flow without gaps.
// OSM coastlines are directed with land on the left, water on the right;
// joining keeps that, so a positive line-offset always steps into the water.
// usage: node scripts/coast.mjs <place> [iterations]  → places/<place>/data/coast.geojson
import fs from 'node:fs';

const place = process.argv[2] || 'richardson-bay';
const iters = Number(process.argv[3] || 3);
const osm = JSON.parse(fs.readFileSync(`places/${place}/data/osm.geojson`, 'utf8'));

// 1. collect directed pieces (closed islands come as polygons: use their outer ring)
let pieces = [];
for (const f of osm.features) {
  if (f.properties.natural !== 'coastline') continue;
  const g = f.geometry;
  if (g.type === 'LineString') pieces.push(g.coordinates);
  else if (g.type === 'Polygon') pieces.push(g.coordinates[0]);
  else if (g.type === 'MultiPolygon') g.coordinates.forEach(p => pieces.push(p[0]));
}
const key = (p) => p[0].toFixed(7) + ',' + p[1].toFixed(7);

// 2. join end-to-start until nothing more connects
const lines = [];
while (pieces.length) {
  let line = pieces.pop();
  for (let grew = true; grew;) {
    grew = false;
    const i = pieces.findIndex(p => key(p[0]) === key(line[line.length - 1]));
    if (i >= 0) { line = line.concat(pieces.splice(i, 1)[0].slice(1)); grew = true; }
    const j = pieces.findIndex(p => key(p[p.length - 1]) === key(line[0]));
    if (j >= 0) { line = pieces.splice(j, 1)[0].slice(0, -1).concat(line); grew = true; }
  }
  lines.push(line);
}

// 3. Chaikin corner-cutting; closed rings stay closed, open ends stay pinned
function chaikin(pts, closed) {
  const out = closed ? [] : [pts[0]];
  const n = pts.length - (closed ? 1 : 0);
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
  }
  if (closed) out.push(out[0]); else out.push(pts[pts.length - 1]);
  return out;
}
const features = lines.map(l => {
  const closed = key(l[0]) === key(l[l.length - 1]);
  let s = l;
  for (let k = 0; k < iters; k++) s = chaikin(s, closed);
  return { type: 'Feature', properties: { closed }, geometry: { type: 'LineString',
    coordinates: s.map(p => [+p[0].toFixed(6), +p[1].toFixed(6)]) } };
});
fs.writeFileSync(`places/${place}/data/coast.geojson`, JSON.stringify({ type: 'FeatureCollection', features }));
console.log(`${lines.length} coast lines (from pieces), ${features.filter(f => f.properties.closed).length} closed, smoothed ×${iters}`);
