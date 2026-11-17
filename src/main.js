import * as maplibregl from 'maplibre-gl';
import mlcontour from 'maplibre-contour';
import { ipswich as c } from './palette.js';
import { buildStyle, outsideMask } from './style.js';
import { addImages } from './patterns.js';
import { LabelLayer, STYLES } from './labels.js';

window.maplibregl = maplibregl;
const place = new URLSearchParams(location.search).get('place') || 'marin-headlands';
const base = `places/${place}`;

const [cfg, osm, labels] = await Promise.all([
  fetch(`${base}/place.json`).then(r => r.json()),
  fetch(`${base}/data/osm.geojson`).then(r => r.json()),
  fetch(`${base}/labels.json`).then(r => (r.ok ? r.json() : [])),
]);
document.title = `${cfg.name} ${cfg.subtitle}`;
document.getElementById('title').textContent = cfg.title || cfg.name;
document.getElementById('subtitle').textContent = cfg.subtitle || 'Trails Guide';
document.getElementById('org').textContent = cfg.org || '';
document.getElementById('areas').innerHTML = (cfg.areas || []).map(a => `<li>${a}</li>`).join('');

const names = cfg.boundaries || [cfg.name];
const boundaries = osm.features.filter(f => f.properties.boundary && names.includes(f.properties.name));
const mask = outsideMask(boundaries);
const designZoom = cfg.zoom;

// Contours in feet, generated in a worker from Terrarium DEM tiles.
const demSource = new mlcontour.DemSource({
  url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  encoding: 'terrarium', maxzoom: 14, worker: true,
});
demSource.setupMaplibre(maplibregl);
const contourTiles = (mode) => demSource.contourProtocolUrl({
  multiplier: 3.28084, // metres → feet
  // [minor, index] interval per zoom. Paper mode keeps one interval at every zoom.
  thresholds: mode === 'paper'
    ? { 10: [20, 100], 11: [20, 100], 12: [20, 100], 13: [20, 100], 14: [20, 100] }
    : { 10: [200, 1000], 11: [100, 500], 12: [50, 250], 13: [40, 200], 14: [20, 100] },
  elevationKey: 'ele', levelKey: 'level', contourLayer: 'contours', overzoom: 1,
});

const state = { mode: 'web', hillshade: false };
// OSM labels to suppress: anything a hand label already covers (or says it replaces)
const handNames = labels.flatMap(l => [l.text.replace(/\n/g, ' '), ...(l.replaces ? [l.replaces] : [])]);
const style = () => buildStyle({ c, osm, mask, contourTiles: contourTiles(state.mode), mode: state.mode,
  designZoom, hillshade: state.hillshade, handNames });

const [w, s, e, n] = cfg.bbox;
const map = new maplibregl.Map({
  container: 'map', style: style(), center: cfg.center, zoom: designZoom,
  maxBounds: [[w - 0.08, s - 0.05], [e + 0.08, n + 0.05]], attributionControl: false, hash: true,
});
map.on('styleimagemissing', () => {}); // images are added below
map.on('style.load', () => addImages(map, c));
map.addControl(new maplibregl.ScaleControl({ unit: 'imperial', maxWidth: 160 }), 'bottom-right');
map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'bottom-right');
map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: '© OpenStreetMap contributors' }));

const zoomEl = document.getElementById('zoom');
const showZoom = () => (zoomEl.textContent = `z${map.getZoom().toFixed(1)}`);
map.on('zoom', showZoom); showZoom();

// --- labels + editor
const insp = document.getElementById('inspector');
const $ = (id) => document.getElementById(id);
$('i-style').innerHTML = Object.keys(STYLES).map(k => `<option>${k}</option>`).join('');
const layer = new LabelLayer(map, {
  place, labels, mode: state.mode, designZoom,
  onSelect(l) {
    insp.hidden = !l;
    if (!l) return;
    $('i-text').value = l.text.replace(/\n/g, '\\n');
    $('i-style').value = l.style;
    $('i-size').value = l.size || 13;
    $('i-rotate').value = l.rotate || 0;
    $('i-spacing').value = l.spacing ?? STYLES[l.style]?.spacing ?? 0;
    $('i-minzoom').value = l.minzoom ?? '';
  },
});
const edit = (key, conv = (v) => v) => (ev) => layer.selected != null && layer.update(layer.selected, { [key]: conv(ev.target.value) });
$('i-text').addEventListener('input', edit('text', v => v.replace(/\\n/g, '\n')));
$('i-style').addEventListener('change', edit('style'));
$('i-size').addEventListener('input', edit('size', Number));
$('i-rotate').addEventListener('input', edit('rotate', Number));
$('i-spacing').addEventListener('input', edit('spacing', Number));
$('i-minzoom').addEventListener('change', edit('minzoom', v => (v === '' ? undefined : Number(v))));
$('i-delete').addEventListener('click', () => layer.selected != null && layer.remove(layer.selected));
$('edit').addEventListener('change', (ev) => { layer.setEditing(ev.target.checked); insp.hidden = true; });
map.on('click', (ev) => {
  if (layer.editing && ev.originalEvent.altKey) layer.add([+ev.lngLat.lng.toFixed(5), +ev.lngLat.lat.toFixed(5)]);
  else if (layer.editing) layer.select(null);
});

// --- toolbar
document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
  state.mode = b.dataset.mode;
  document.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x === b));
  map.setStyle(style(), { diff: false });
  layer.setMode(state.mode);
}));
$('hillshade').addEventListener('change', (ev) => { state.hillshade = ev.target.checked; map.setStyle(style(), { diff: false }); });

window.map = map; // for poking at in devtools
