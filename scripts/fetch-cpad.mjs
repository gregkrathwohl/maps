// Public land from the California Protected Areas Database (CPAD, GreenInfo Network, www.calands.org):
// every park and open space preserve in California, with who owns it and whether the public may go in.
// OSM is missing some (e.g. Marin's Lucas Valley and Indian Valley preserves on Big Rock Ridge), so the map
// draws open space from both. Writes places/<place>/data/cpad.geojson.
// usage: node scripts/fetch-cpad.mjs <place>
import fs from 'node:fs';

const place = process.argv[2];
const cfg = JSON.parse(fs.readFileSync(`places/${place}/place.json`, 'utf8'));
const URL0 = 'https://services1.arcgis.com/4ZKi1B1zTblbwgWB/ArcGIS/rest/services/CPAD_Holdings_Current_Release/FeatureServer/0/query';
const FIELDS = ['UNIT_NAME', 'SITE_NAME', 'ACCESS_TYP', 'MNG_AGNCY', 'AGNCY_LEV', 'ACRES', 'PARK_URL'];

const features = [];
for (let offset = 0; ; offset += 1000) {
  const q = new URLSearchParams({
    where: '1=1', geometry: cfg.bbox.join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', outFields: FIELDS.join(','), outSR: '4326',
    resultOffset: offset, resultRecordCount: 1000, f: 'geojson',
  });
  const res = await fetch(`${URL0}?${q}`);
  if (!res.ok) throw new Error(`CPAD ${res.status}`);
  const page = await res.json();
  features.push(...page.features);
  if (page.features.length < 1000 && !page.properties?.exceededTransferLimit) break;
}
const gj = {
  type: 'FeatureCollection',
  features: features.map(f => ({ type: 'Feature', geometry: f.geometry, properties: {
    unit: f.properties.UNIT_NAME, site: f.properties.SITE_NAME, access: f.properties.ACCESS_TYP,
    agency: f.properties.MNG_AGNCY, level: f.properties.AGNCY_LEV, acres: f.properties.ACRES, url: f.properties.PARK_URL } })),
};
const out = `places/${place}/data/cpad.geojson`;
fs.writeFileSync(out, JSON.stringify(gj));
const by = {};
for (const f of gj.features) by[f.properties.access] = (by[f.properties.access] || 0) + 1;
console.log(out, gj.features.length, 'holdings', by, (fs.statSync(out).size / 1e6).toFixed(1) + 'MB');
