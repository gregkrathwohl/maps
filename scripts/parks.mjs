// Pick a place's parks from its OSM data and merge them into data/boundary.geojson (the shape
// that stays clear; everything outside gets the grey wash).
//   node scripts/parks.mjs <place>     (also used by serve.mjs when a new map is created)
// A park is a named protected area / national park / nature reserve that really covers at least
// 15% of the frame, measured by point-in-polygon on a 40×40 grid (bounding boxes lie: GGNRA's
// is huge). Up to 4, merged with polygon-clipping so overlaps don't cancel out.
import fs from 'node:fs';
import path from 'node:path';
import polygonClipping from 'polygon-clipping';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const inRing = (x, y, r) => {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const polys = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);
const inPoly = (x, y, g) => polys(g).some(([outer, ...holes]) => inRing(x, y, outer) && !holes.some(h => inRing(x, y, h)));

export function pickParks(id, { min = 0.15, max = 4, G = 40 } = {}) {
  const dir = path.join(root, 'places', id);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'place.json'), 'utf8'));
  const osm = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'osm.geojson'), 'utf8'));
  const [w, s, e, n] = cfg.bbox;
  const picks = [];
  for (const f of osm.features) {
    const p = f.properties, g = f.geometry;
    if (!p.name || /marine|sanctuary/i.test(p.name) || !['Polygon', 'MultiPolygon'].includes(g?.type)) continue;
    if (!(['protected_area', 'national_park'].includes(p.boundary) || p.leisure === 'nature_reserve')) continue;
    let hit = 0;
    for (let i = 0; i < G; i++) for (let j = 0; j < G; j++)
      if (inPoly(w + (e - w) * (i + 0.5) / G, s + (n - s) * (j + 0.5) / G, g)) hit++;
    if (hit / (G * G) >= min) picks.push({ name: p.name, share: hit / (G * G), g });
  }
  picks.sort((a, b) => b.share - a.share);
  const names = [...new Set(picks.map(p => p.name))].slice(0, max);
  const geoms = picks.filter(p => names.includes(p.name)).map(p => polys(p.g));
  const out = path.join(dir, 'data', 'boundary.geojson');
  if (geoms.length) {
    fs.writeFileSync(out, JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature',
      properties: { names }, geometry: { type: 'MultiPolygon', coordinates: polygonClipping.union(...geoms) } }] }));
  } else if (fs.existsSync(out)) fs.rmSync(out);
  return names;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const id = process.argv[2];
  const names = pickParks(id);
  const f = path.join(root, 'places', id, 'place.json');
  const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
  cfg.boundaries = names;
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n');
  console.log(id, '→', names.join(', ') || '(no park: nothing greyed out)');
}
