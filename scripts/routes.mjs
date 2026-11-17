// Build paddling legs from places/<place>/routes.json:
//   { "waypoints": { "<id>": { "name", "kind": "launch|landing|mark", "at": [lon,lat] | "seamark": "<seamark:name>" } },
//     "legs": [["a","b"], ["b","c"], ...] }
// A waypoint can snap to a buoy by its OSM seamark name, so legs run buoy to buoy.
// Writes places/<place>/data/routes.geojson: launch/landing points + leg lines labelled in nautical miles.
import fs from 'node:fs';

const place = process.argv[2] || 'richardson-bay';
const cfg = JSON.parse(fs.readFileSync(`places/${place}/routes.json`, 'utf8'));
const osm = JSON.parse(fs.readFileSync(`places/${place}/data/osm.geojson`, 'utf8'));
const atonPath = `places/${place}/data/aton.geojson`;
const aton = fs.existsSync(atonPath) ? JSON.parse(fs.readFileSync(atonPath, 'utf8')).features : [];

const NM = 1852;
const dist = ([x1, y1], [x2, y2]) => {
  const r = Math.PI / 180, a = Math.sin((y2 - y1) * r / 2) ** 2 + Math.cos(y1 * r) * Math.cos(y2 * r) * Math.sin((x2 - x1) * r / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(a));
};

const pts = {};
for (const [id, w] of Object.entries(cfg.waypoints)) {
  let at = w.at;
  if (w.osm) { // centroid of a named OSM feature
    const f = osm.features.find(f => f.properties.name === w.osm);
    if (!f) throw new Error(`no OSM feature named "${w.osm}"`);
    const flat = (c) => (typeof c[0] === 'number' ? [c] : c.flatMap(flat));
    const pts = flat(f.geometry.coordinates);
    at = [0, 1].map(k => +(pts.reduce((a, p) => a + p[k], 0) / pts.length).toFixed(5));
  }
  if (w.seamark) {
    // NOAA chart name first (aton.geojson), then OSM seamark:name
    const f = aton.find(f => f.properties.name === w.seamark)
      || osm.features.find(f => f.geometry.type === 'Point' && f.properties['seamark:name'] === w.seamark);
    if (!f) throw new Error(`no seamark named "${w.seamark}"`);
    at = f.geometry.coordinates;
  }
  pts[id] = { ...w, at };
}

const features = Object.entries(pts)
  .filter(([, w]) => w.kind === 'launch' || w.kind === 'landing')
  .map(([id, w]) => ({ type: 'Feature', properties: { id, name: w.name, kind: w.kind }, geometry: { type: 'Point', coordinates: w.at } }));

let total = 0;
for (const [a, b] of cfg.legs) {
  const d = dist(pts[a].at, pts[b].at) / NM;
  total += d;
  features.push({ type: 'Feature', properties: { from: a, to: b, nm: +d.toFixed(2), label: `${d.toFixed(1)} nm` },
    geometry: { type: 'LineString', coordinates: [pts[a].at, pts[b].at] } });
  console.log(`${pts[a].name || a} → ${pts[b].name || b}: ${d.toFixed(2)} nm`);
}
fs.writeFileSync(`places/${place}/data/routes.geojson`, JSON.stringify({ type: 'FeatureCollection', features }));
console.log(`total ${total.toFixed(1)} nm over ${cfg.legs.length} legs`);
