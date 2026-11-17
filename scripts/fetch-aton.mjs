// Aids to navigation (buoys, beacons, lights, daymarks) from NOAA ENC Direct,
// harbour-scale charts. Public domain US government data.
// usage: node scripts/fetch-aton.mjs <place>  → places/<place>/data/aton.geojson
import fs from 'node:fs';

const place = process.argv[2] || 'richardson-bay';
const [w, s, e, n] = JSON.parse(fs.readFileSync(`places/${place}/place.json`, 'utf8')).bbox;
const base = 'https://encdirect.noaa.gov/arcgis/rest/services/encdirect/enc_harbour/MapServer';
const layers = {
  1: 'beacon_lateral', 2: 'beacon_safe_water', 3: 'beacon_special_purpose', 4: 'buoy_cardinal',
  5: 'buoy_isolated_danger', 6: 'buoy_lateral', 7: 'buoy_safe_water', 8: 'buoy_special_purpose', 9: 'daymark', 11: 'light',
};
const features = [];
for (const [id, kind] of Object.entries(layers)) {
  const q = new URLSearchParams({ geometry: `${w},${s},${e},${n}`, geometryType: 'esriGeometryEnvelope', inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', outFields: '*', outSR: '4326', f: 'geojson' });
  const r = await fetch(`${base}/${id}/query?${q}`);
  const j = await r.json();
  for (const f of j.features || []) features.push({ ...f, properties: { ...f.properties, kind } });
  console.log(kind, (j.features || []).length);
}
// S-57 colour codes → names; chart-style short labels ("R 8", "G 9", "A")
const COLOURS = { 1: 'white', 2: 'black', 3: 'red', 4: 'green', 5: 'blue', 6: 'yellow', 11: 'orange' };
const near = (a, b) => Math.hypot((a[0] - b[0]) * 79000, (a[1] - b[1]) * 111000) < 15;
// skip: daymarks (duplicates of their beacons) and the Richardson Bay special-anchorage buoys (not useful here)
const marks = features.filter(f => f.properties.kind !== 'daymark' && f.properties.kind !== 'light' && !/Special Anchorage/.test(f.properties.OBJNAM || ''));
// a light usually sits on a beacon/buoy already listed; keep only standalone lights
const skipped = features.filter(f => /Special Anchorage/.test(f.properties.OBJNAM || ''));
for (const f of features.filter(f => f.properties.kind === 'light'))
  if (![...marks, ...skipped].some(m => near(m.geometry.coordinates, f.geometry.coordinates))) marks.push(f);
const out = marks.map(f => {
  const p = f.properties, name = p.OBJNAM || '';
  const colour = COLOURS[String(p.COLOUR || '').split(',')[0]] || (p.kind === 'light' ? 'light' : 'other');
  const num = name.match(/(?:Daybeacon|Light|Buoy)\s+([A-Z0-9]+)$/)?.[1];
  const short = num ? `${colour === 'red' ? 'R ' : colour === 'green' ? 'G ' : ''}${num}` : name.replace(/ Light$/, '');
  // friendly label for the big channel marks: "Harding Rock HR", "Raccoon Strait G 3", "Cone Rock"
  const where = name.replace(/\s*(Lighted |Light )?(Bell |Whistle |Gong )?(Buoy|Daybeacon|Light)(\s+[A-Z0-9]+)?$/, '')
    .replace(/^San Francisco Bay /, '').trim();
  const anchorage = name.match(/Special Anchorage .*Buoy ([A-Z])$/)?.[1];
  const inner = /^Richardson Bay|^$/.test(name) && p.kind !== 'light' && !anchorage;
  // lettered marks (HR, AZ, A) read better as their letters alone: Harding Rock "HR"
  const mark = num && /^[A-Z]+$/.test(num) ? `“${num}”` : short;
  const label = anchorage ? `Anchorage ${anchorage}` : inner ? short : where && where !== short ? (num ? `${where} ${mark}` : where) : short;
  return { type: 'Feature', geometry: f.geometry,
    properties: { kind: p.kind, name, colour, short, label, inner, buoy: p.kind.startsWith('buoy') } };
});
// marks not (yet) on the NOAA chart, e.g. private racing buoys: places/<place>/aton-extra.json
const extraPath = `places/${place}/aton-extra.json`;
if (fs.existsSync(extraPath)) for (const x of JSON.parse(fs.readFileSync(extraPath, 'utf8')))
  out.push({ type: 'Feature', geometry: { type: 'Point', coordinates: x.at },
    properties: { kind: x.kind || 'buoy_special_purpose', name: x.name, colour: x.colour, short: x.short || '', label: x.label, inner: false, buoy: true, source: x.source } });
fs.writeFileSync(`places/${place}/data/aton.geojson`, JSON.stringify({ type: 'FeatureCollection', features: out }));
console.log('wrote', out.length, 'aids (daymarks and duplicate lights dropped)');
