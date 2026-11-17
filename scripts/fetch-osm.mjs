// Fetch OSM features for a bbox via Overpass and write GeoJSON layers.
// usage: node scripts/fetch-osm.mjs <place>   (reads places/<place>/place.json)
import fs from 'node:fs';
import osmtogeojson from 'osmtogeojson';

const place = process.argv[2] || 'marin-headlands';
const cfg = JSON.parse(fs.readFileSync(`places/${place}/place.json`, 'utf8'));
const [w, s, e, n] = cfg.bbox;
const bb = `${s},${w},${n},${e}`;

const q = `[out:json][timeout:120];
(
  way["highway"](${bb});
  way["natural"](${bb}); relation["natural"](${bb});
  way["landuse"](${bb}); relation["landuse"](${bb});
  way["leisure"](${bb}); relation["leisure"](${bb});
  way["boundary"="protected_area"](${bb}); relation["boundary"~"protected_area|national_park"](${bb});
  way["waterway"](${bb});
  way["building"](${bb});
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

const endpoints = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
let json;
for (let attempt = 0; attempt < 6 && !json; attempt++) {
  const url = endpoints[attempt % endpoints.length];
  try {
    const res = await fetch(url, {
      method: 'POST', body: 'data=' + encodeURIComponent(q),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'trail-cartography-prototype' },
    });
    if (res.ok) json = await res.json();
    else console.warn(url, res.status);
  } catch (err) { console.warn(url, err.message); }
  if (!json) await new Promise(r => setTimeout(r, 2000 * 2 ** attempt));
}
if (!json) throw new Error('all Overpass attempts failed');
const gj = osmtogeojson(json);
const out = `places/${place}/data/osm.geojson`;
fs.mkdirSync(`places/${place}/data`, { recursive: true });
// keep tags flat + drop untagged
const keys = /^(highway|natural|landuse|leisure|boundary|waterway|building|military|historic|amenity|tourism|man_made|place|bridge|name|seamark:type|canoe)$/;
gj.features = gj.features
  .filter(f => Object.keys(f.properties).some(k => keys.test(k)))
  // water maps never draw buildings: leave them out (they're most of a city's data)
  .filter(f => cfg.style !== 'bay' || !(f.properties.building && !f.properties.name && !f.properties.historic && !f.properties.amenity))
  .map(f => ({ type: 'Feature', geometry: f.geometry, properties: { ...f.properties, _id: f.id ?? f.properties.id } }));
fs.writeFileSync(out, JSON.stringify(gj));
console.log(out, gj.features.length, 'features', (fs.statSync(out).size / 1e6).toFixed(1) + 'MB');
