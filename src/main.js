import * as maplibregl from 'maplibre-gl';
import mlcontour from 'maplibre-contour';
import { ipswich as c } from './palette.js';
import { buildStyle, outsideMask } from './style.js';
import { buildBayStyle } from './bay-style.js';
import { addImages } from './patterns.js';
import { LabelLayer, STYLES } from './labels.js';
import { Router } from './router.js';
import { resolver, buildTrip, summary } from './trips.js';

window.maplibregl = maplibregl;
const place = new URLSearchParams(location.search).get('place') || 'marin-headlands';
const base = `places/${place}`;

const empty = { type: 'FeatureCollection', features: [] };
const optional = (url) => fetch(url).then(r => (r.ok ? r.json() : empty)).catch(() => empty);
const [cfg, osm, labels, currents, routes, aton, coastLines, ripples, trips] = await Promise.all([
  fetch(`${base}/place.json`).then(r => r.json()),
  fetch(`${base}/data/osm.geojson`).then(r => r.json()),
  fetch(`${base}/labels.json`).then(r => (r.ok ? r.json() : [])),
  optional(`${base}/data/currents.geojson`),
  optional(`${base}/data/routes.geojson`),
  optional(`${base}/data/aton.geojson`),
  optional(`${base}/data/coast.geojson`),
  optional(`${base}/data/ripples.geojson`),
  fetch(`${base}/trips.json`).then(r => (r.ok ? r.json() : [])).catch(() => []),
]);
const bay = cfg.style === 'bay';
if (bay) document.querySelector('.key').innerHTML = `
  <div class="k"><i class="sw kayak"></i>Launch / landing</div>
  <div class="k"><i class="sw depth"></i>Depth, shallow → deep</div>
  <div class="k"><i class="sw isobath"></i>Depth contour, 20 ft · or shore ripples</div>
  <div class="k"><i class="sw trail dashed"></i>Paddling route, nautical miles</div>
  <div class="k"><i class="sw buoy red"></i><i class="sw buoy green"></i>Buoys &amp; markers</div>
  <div class="k"><i class="sw fill beach"></i>Beach</div>
  <div class="k"><i class="sw fill os"></i>Park land</div>
  <p class="src">Data: OpenStreetMap, NOAA ENC (buoys &amp; beacons), OpenFreeMap, AWS Terrain Tiles bathymetry. Not for navigation.</p>`;
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

const state = { mode: 'web', hillshade: false, waterMode: 'ripples', trip: empty };
// OSM labels to suppress: anything a hand label already covers (or says it replaces)
const handNames = labels.flatMap(l => [l.text.replace(/\n/g, ' '), ...(l.replaces ? [l.replaces] : [])]);
const style = () => (bay ? buildBayStyle : buildStyle)({ c: bay ? undefined : c, osm, mask, currents, routes, aton, coastLines,
  ripples, trips: state.trip, waterMode: state.waterMode,
  contourTiles: contourTiles(state.mode), mode: state.mode, designZoom, hillshade: state.hillshade, handNames });

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

// --- bay maps: water texture switch, saved routes, route planner
if (bay) {
  const router = await Router.load(base);
  const resolve = resolver(osm, aton);
  const waterSel = $('water-mode'), tripSel = $('trip-select'), planner = $('planner');
  waterSel.hidden = tripSel.hidden = false;
  waterSel.addEventListener('change', () => { state.waterMode = waterSel.value; map.setStyle(style(), { diff: false }); });

  const showTrip = (t) => { state.trip = t.geojson; map.getSource('trips')?.setData(t.geojson); };
  const renderPanel = (t, title) => {
    const sm = summary(t);
    $('pl-title').textContent = title;
    $('pl-total').textContent = t.legs.length ? sm.total : '';
    $('pl-legs').innerHTML = sm.legs.map(l => `<li>${l}</li>`).join('');
  };
  tripSel.innerHTML = `<option value="">No route</option>` +
    trips.map((t, i) => `<option value="${i}">${t.name}</option>`).join('') + `<option value="plan">Plan a route…</option>`;

  let plan = [];
  const planning = () => tripSel.value === 'plan';
  const refresh = () => {
    if (planning()) { const t = buildTrip(router, plan); showTrip(t); renderPanel(t, 'Plan a route'); return; }
    if (tripSel.value === '') { showTrip({ geojson: empty }); planner.hidden = true; return; }
    const trip = trips[+tripSel.value];
    const t = buildTrip(router, trip.stops.map(resolve).filter(Boolean));
    showTrip(t); renderPanel(t, trip.name);
  };
  tripSel.addEventListener('change', () => {
    planner.hidden = tripSel.value === '';
    document.body.classList.toggle('planning', planning());
    for (const el of ['pl-undo', 'pl-clear', 'pl-save']) $(el).hidden = !planning();
    planner.querySelector('.hint').hidden = !planning();
    refresh();
  });
  $('pl-buf').addEventListener('input', (ev) => { $('pl-buf-val').textContent = ev.target.value; router?.setBuffer(+ev.target.value); refresh(); });
  $('pl-undo').addEventListener('click', () => { plan.pop(); refresh(); });
  $('pl-clear').addEventListener('click', () => { plan = []; refresh(); });
  $('pl-save').addEventListener('click', async () => {
    if (plan.length < 2) return;
    const name = prompt('Name this route'); if (!name) return;
    trips.push({ name, stops: plan.map(p => p.ref) });
    await fetch(`${base}/trips.json`, { method: 'PUT', body: JSON.stringify(trips, null, 1) });
    const i = trips.length - 1;
    tripSel.insertAdjacentHTML('beforeend', '');
    tripSel.querySelector('option[value="plan"]').insertAdjacentHTML('beforebegin', `<option value="${i}">${name}</option>`);
    plan = []; tripSel.value = String(i); tripSel.dispatchEvent(new Event('change'));
  });
  // clicks near a buoy, beacon or launch snap to it (and are saved by name)
  map.on('click', (ev) => {
    if (!planning() || layer.editing) return;
    // snap to a buoy/beacon/launch only when the click is right on it; hold Alt (⌥) to never snap
    const p = ev.point, box = [[p.x - 7, p.y - 7], [p.x + 7, p.y + 7]];
    const hit = ev.originalEvent?.altKey ? null
      : map.queryRenderedFeatures(box, { layers: ['buoy', 'beacon', 'launch'].filter(id => map.getLayer(id)) })[0];
    if (hit?.properties.name && hit.source === 'aton') plan.push({ at: hit.geometry.coordinates, name: hit.properties.label, ref: `aton:${hit.properties.name}` });
    else if (hit?.properties.name && hit.source === 'routes') plan.push({ at: hit.geometry.coordinates, name: hit.properties.name, ref: hit.geometry.coordinates });
    else {
      // a click on land becomes the nearest open water (respecting the off-shore buffer)
      let at = [+ev.lngLat.lng.toFixed(5), +ev.lngLat.lat.toFixed(5)];
      if (router) at = router.toWater(at);
      plan.push({ at, name: null, ref: at });
    }
    refresh();
  });
  // a full style reload (Web/Paper, water switch) drops the route data: put it back
  map.on('style.load', () => map.getSource('trips')?.setData(state.trip));
}

window.map = map; // for poking at in devtools
