// Static build for GitHub Pages → dist/
//   index.html  = the map library (lists every place)
//   map.html    = the map, in public mode (no label editor, grid, tuning, route saving)
//   vendor/     = maplibre-gl + maplibre-contour
//   places/<id> = place config + data the map loads
// Paths are relative, so it works under any sub-path (gregkrathwohl.github.io/maps/).
import fs from 'node:fs';
import path from 'node:path';

const out = 'dist';
fs.rmSync(out, { recursive: true, force: true });
const copy = (from, to) => { fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true }); fs.copyFileSync(from, path.join(out, to)); };

// libraries
for (const f of ['maplibre-gl.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl.css']) copy(`node_modules/maplibre-gl/dist/${f}`, `vendor/maplibre-gl/${f}`);
copy('node_modules/maplibre-contour/dist/index.mjs', 'vendor/maplibre-contour/index.mjs');

// app code
for (const f of fs.readdirSync('src')) copy(`src/${f}`, `src/${f}`);

// map page, public mode
let html = fs.readFileSync('index.html', 'utf8')
  .replaceAll('node_modules/maplibre-gl/dist/', 'vendor/maplibre-gl/')
  .replace('./node_modules/maplibre-contour/dist/index.mjs', './vendor/maplibre-contour/index.mjs')
  .replace('<body>', '<body data-public>');
fs.writeFileSync(path.join(out, 'map.html'), html);

// places: config + the data files the map actually loads
const KEEP = ['place.json', 'labels.json', 'trips.json', 'routes.json'];
const DATA = ['osm.geojson', 'boundary.geojson', 'relief-grey.png', 'aton.geojson', 'coast.geojson', 'ripples.geojson', 'routes.geojson',
  'navgrid.png', 'navgrid.json', 'currents-sfbofs.json', 'tides.json'];
const list = [];
for (const id of fs.readdirSync('places')) {
  const dir = `places/${id}`;
  if (!fs.existsSync(`${dir}/place.json`)) continue;
  if (JSON.parse(fs.readFileSync(`${dir}/place.json`, 'utf8')).draft) continue;   // new maps stay local until published
  for (const f of KEEP) if (fs.existsSync(`${dir}/${f}`)) copy(`${dir}/${f}`, `${dir}/${f}`);
  for (const f of DATA) if (fs.existsSync(`${dir}/data/${f}`)) copy(`${dir}/data/${f}`, `${dir}/data/${f}`);
  list.push({ id, ...JSON.parse(fs.readFileSync(`${dir}/place.json`, 'utf8')) });
}
fs.writeFileSync(path.join(out, 'places.json'), JSON.stringify(list));

// library page = home
const lib = fs.readFileSync('library.html', 'utf8')
  .replace("fetch('/api/places')", "fetch('places.json')")
  .replace('href="/?place=${p.id}"', 'href="map.html?place=${p.id}"')
  .replace(/<a class="new"[^>]*>[^<]*<\/a>/, '');
fs.writeFileSync(path.join(out, 'index.html'), lib);
fs.writeFileSync(path.join(out, '.nojekyll'), '');

let bytes = 0;
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach(e => e.isDirectory() ? walk(path.join(d, e.name)) : (bytes += fs.statSync(path.join(d, e.name)).size));
walk(out);
console.log(`dist/: ${list.length} places, ${(bytes / 1e6).toFixed(1)} MB`);
