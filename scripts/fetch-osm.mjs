// Fetch OSM features for a bbox and write GeoJSON layers.
// usage: node scripts/fetch-osm.mjs <place>                    live, via the Overpass API (slow for big places)
//        node scripts/fetch-osm.mjs <place> --pbf <file.pbf>   from a downloaded extract (e.g. Geofabrik's daily
//                                                             norcal-latest.osm.pbf in ~/dev/osm-data), with osmium
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import osmtogeojson from 'osmtogeojson';
const pbfArg = process.argv.indexOf('--pbf');
const PBF = pbfArg > 0 ? process.argv[pbfArg + 1].replace(/^~/, os.homedir()) : null;

const place = process.argv[2] || 'marin-headlands';
const cfg = JSON.parse(fs.readFileSync(`places/${place}/place.json`, 'utf8'));
const [w, s, e, n] = cfg.bbox;
// big places come down in pieces (place.json "fetchGrid": 3 → 3×3); pieces are merged by OSM id
const G = cfg.fetchGrid || 1;
const query = (bb) => `[out:json][timeout:300];
(
  way["highway"](${bb});
  way["natural"](${bb}); relation["natural"](${bb});
  way["landuse"](${bb}); relation["landuse"](${bb});
  way["leisure"](${bb}); relation["leisure"](${bb});
  way["boundary"="protected_area"](${bb}); relation["boundary"~"protected_area|national_park"](${bb});
  way["waterway"](${bb});
  ${cfg.buildings === false ? `way["building"]["name"](${bb});` : `way["building"](${bb});`}
  way["military"](${bb}); node["historic"](${bb}); way["historic"](${bb});
  node["natural"~"peak|cape|beach|bay|cliff"](${bb});
  node["amenity"~"parking|toilets|drinking_water"](${bb}); way["amenity"="parking"](${bb});
  node["tourism"~"viewpoint|camp_site|information|museum|hostel"](${bb}); way["tourism"~"camp_site|museum|hostel"](${bb});
  node["man_made"~"lighthouse"](${bb}); way["man_made"~"lighthouse|pier|bridge"](${bb});
  way["place"](${bb}); node["place"](${bb});
  way["bridge"](${bb});
  node["seamark:type"](${bb}); way["seamark:type"](${bb});
  node["canoe"](${bb}); node["leisure"="slipway"](${bb}); way["leisure"~"slipway|marina"](${bb});
);
out body; >; out skel qt;`;

async function overpass(q) {

const endpoints = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  let json;
  for (let attempt = 0; attempt < 10 && !json; attempt++) {
  const url = endpoints[attempt % endpoints.length];
  try {
    const res = await fetch(url, {
      method: 'POST', body: 'data=' + encodeURIComponent(q),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'trail-cartography-prototype' },
    });
    if (res.ok) json = await res.json();
    else console.warn(url, res.status);
  } catch (err) { console.warn(url, err.message); }
  if (!json) await new Promise(r => setTimeout(r, Math.min(60000, 2000 * 2 ** attempt)));
}
  if (!json) throw new Error('all Overpass attempts failed');
  return json;
}
// the same features as the Overpass query, as osmium tags-filter expressions
const FILTERS = ['w/highway', 'wr/natural', 'n/natural=peak,cape,beach,bay,cliff', 'wr/landuse', 'wr/leisure',
  'wr/boundary=protected_area', 'r/boundary=national_park', 'w/waterway', 'w/building', 'w/military', 'nw/historic',
  'n/amenity=parking,toilets,drinking_water', 'w/amenity=parking', 'n/tourism=viewpoint,camp_site,information,museum,hostel',
  'w/tourism=camp_site,museum,hostel', 'n/man_made=lighthouse', 'w/man_made=lighthouse,pier,bridge', 'nw/place', 'w/bridge',
  'nw/seamark:type', 'n/canoe', 'n/leisure=slipway'];
function fromPbf(file) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-')), run = (...a) => execFileSync('osmium', a, { stdio: ['ignore', 'ignore', 'inherit'] });
  // cut the box (smart: ways and multipolygons that cross the edge come whole), keep our tags, export
  run('extract', '-b', [w, s, e, n].join(','), '--strategy', 'smart', '-S', 'types=multipolygon,boundary', file, '-o', `${tmp}/box.pbf`, '--overwrite');
  run('tags-filter', `${tmp}/box.pbf`, ...FILTERS, '-o', `${tmp}/keep.pbf`, '--overwrite');
  run('export', `${tmp}/keep.pbf`, '--add-unique-id=type_id', '-o', `${tmp}/out.geojson`, '--overwrite');
  const gj = JSON.parse(fs.readFileSync(`${tmp}/out.geojson`, 'utf8'));
  // osmium also exports tagged nodes that are only there as parts of ways (crossings, signals, gates):
  // keep just the point features the Overpass query asks for
  const is = (v, re) => v != null && re.test(v);
  gj.features = gj.features.filter(({ geometry: g, properties: p }) => g.type !== 'Point' ||
    is(p.natural, /^(peak|cape|beach|bay|cliff)$/) || is(p.amenity, /^(parking|toilets|drinking_water)$/) ||
    is(p.tourism, /^(viewpoint|camp_site|information|museum|hostel)$/) || p.man_made === 'lighthouse' ||
    p.historic != null || p.place != null || p['seamark:type'] != null || p.canoe != null || p.leisure === 'slipway');
  fs.rmSync(tmp, { recursive: true, force: true });
  // ids as osmtogeojson writes them ("way/123"), so both sources look the same
  // (osmium numbers areas 2×way id, or 2×relation id + 1)
  const kind = { n: 'node', w: 'way', r: 'relation' };
  for (const f of gj.features) {
    const m = /^([nwra])(\d+)$/.exec(f.id ?? ''); if (!m) continue;
    const k = +m[2];
    f.id = m[1] !== 'a' ? `${kind[m[1]]}/${k}` : k % 2 ? `relation/${(k - 1) / 2}` : `way/${k / 2}`;
  }
  // a closed way comes out twice, as a line and as an area: keep one, like osmtogeojson does
  // (roads, streams, coastline and cliffs stay lines unless tagged area=yes; everything else is an area)
  const lineish = (p) => p.area !== 'yes' && (p.highway != null || p.waterway != null || p.barrier != null ||
    /^(coastline|cliff|tree_row)$/.test(p.natural ?? '') || p.man_made === 'pier');
  const polyIds = new Set(gj.features.filter(f => f.geometry.type.endsWith('Polygon')).map(f => f.id));
  const lineIds = new Set(gj.features.filter(f => f.geometry.type === 'LineString' && polyIds.has(f.id)).map(f => f.id));
  gj.features = gj.features.filter(f => !lineIds.has(f.id) ||
    (f.geometry.type === 'LineString' ? lineish(f.properties) : !lineish(f.properties)));
  return gj;
}

async function fromOverpass() {
const seen = new Map();
for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) {
  const bb = [s + (n - s) * j / G, w + (e - w) * i / G, s + (n - s) * (j + 1) / G, w + (e - w) * (i + 1) / G].map(v => v.toFixed(5)).join(',');
  // each piece is kept on disk until the whole place is done, so a failed run resumes where it stopped
  const cache = `places/${place}/data/pieces/${G}-${i}-${j}.json`;
  let part;
  if (fs.existsSync(cache)) part = JSON.parse(fs.readFileSync(cache, 'utf8'));
  else { part = await overpass(query(bb)); fs.mkdirSync(`places/${place}/data/pieces`, { recursive: true }); fs.writeFileSync(cache, JSON.stringify(part)); }
  // keep the fullest copy of each element (a later piece may carry a node's tags or a way's nodes)
  for (const el of part.elements) { const k = el.type + el.id, old = seen.get(k); if (!old || JSON.stringify(el).length > JSON.stringify(old).length) seen.set(k, el); }
  console.log(`piece ${i * G + j + 1}/${G * G}: ${part.elements.length} elements`);
}
return osmtogeojson({ elements: [...seen.values()] });
}
const gj = PBF ? fromPbf(PBF) : await fromOverpass();
const out = `places/${place}/data/osm.geojson`;
fs.mkdirSync(`places/${place}/data`, { recursive: true });
// keep tags flat + drop untagged
const keys = /^(highway|natural|landuse|leisure|boundary|waterway|building|military|historic|amenity|tourism|man_made|place|bridge|name|seamark:type|canoe)$/;
gj.features = gj.features
  .filter(f => Object.keys(f.properties).some(k => keys.test(k)))
  // water maps never draw buildings: leave them out (they're most of a city's data)
  .filter(f => (cfg.style !== 'bay' && cfg.buildings !== false) || !(f.properties.building && !f.properties.name && !f.properties.historic && !f.properties.amenity))
  // points that came along with a big outline (a city's label node 50 km away) stay out
  .filter(f => f.geometry?.type !== 'Point' || (([x, y]) => x >= w && x <= e && y >= s && y <= n)(f.geometry.coordinates))
  .map(f => ({ type: 'Feature', geometry: f.geometry, properties: { ...f.properties, _id: f.id ?? f.properties.id } }));
fs.writeFileSync(out, JSON.stringify(gj));
fs.rmSync(`places/${place}/data/pieces`, { recursive: true, force: true });
console.log(out, gj.features.length, 'features', (fs.statSync(out).size / 1e6).toFixed(1) + 'MB');
