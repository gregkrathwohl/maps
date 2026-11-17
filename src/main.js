import * as maplibregl from 'maplibre-gl';
import mlcontour from 'maplibre-contour';
import { ipswich as c } from './palette.js';
import { buildStyle, outsideMask } from './style.js';
import { buildBayStyle } from './bay-style.js';
import { addImages } from './patterns.js';
import { LabelLayer, STYLES } from './labels.js';
import { Router } from './router.js';
import { resolver, buildTrip, summary } from './trips.js';
import { FlowLayer, timeLabel, DEFAULTS as FLOW_DEFAULTS } from './flow.js';

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
// shrink the title until its longest word fits the box (e.g. RICHARDSON)
{
  const h1 = document.getElementById('title'), box = h1.parentElement;
  h1.innerHTML = (cfg.title || cfg.name).split(' ').map(w => `<span style="display:block">${w}</span>`).join('');
  const fit = () => {
    h1.style.fontSize = '';
    let size = parseFloat(getComputedStyle(h1).fontSize);
    while (h1.scrollWidth > box.clientWidth - 36 && size > 18) h1.style.fontSize = `${--size}px`;
  };
  fit(); document.fonts?.ready.then(fit); // again once EB Garamond has loaded
}
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

// settings: the place's defaults, then whatever you chose last time on this place (localStorage)
const prefsKey = `trail-cartography:v3:${place}`; // bump vN when the defaults change
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(prefsKey) || '{}'); } catch { return {}; } };
const PUBLIC = document.body.hasAttribute('data-public');
// the public site has no settings UI, so it always uses the place's defaults
const prefs = { mode: 'web', hillshade: false, waterMode: 'ripples', waterShade: 0, currents: true, colour: false, ...(cfg.defaults || {}), ...(PUBLIC ? {} : loadPrefs()) };
const savePrefs = (patch) => { Object.assign(prefs, patch); try { localStorage.setItem(prefsKey, JSON.stringify(prefs)); } catch {} };
const state = { mode: prefs.mode, hillshade: prefs.hillshade, waterMode: prefs.waterMode, trip: empty };
document.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x.dataset.mode === state.mode));
document.getElementById('hillshade').checked = state.hillshade;
// OSM labels to suppress: anything a hand label already covers (or says it replaces)
const handNames = labels.flatMap(l => [l.text.replace(/\n/g, ' '), ...(l.replaces ? [l.replaces] : [])]);
const style = () => (bay ? buildBayStyle : buildStyle)({ c: bay ? undefined : c, osm, mask, currents, routes, aton, coastLines,
  ripples, trips: state.trip, waterMode: state.waterMode, waterShade: prefs.waterShade,
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
// start the attribution collapsed to its ⓘ button (MapLibre opens it on wide screens)
map.once('load', () => document.querySelectorAll('.maplibregl-ctrl-attrib').forEach(el => { el.classList.remove('maplibregl-compact-show'); el.removeAttribute('open'); }));

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
  state.mode = b.dataset.mode; savePrefs({ mode: state.mode });
  document.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x === b));
  map.setStyle(style(), { diff: false });
  layer.setMode(state.mode);
}));
$('hillshade').addEventListener('change', (ev) => { state.hillshade = ev.target.checked; savePrefs({ hillshade: state.hillshade }); map.setStyle(style(), { diff: false }); });

// --- bay maps: water texture switch, saved routes, route planner
if (bay) {
  const router = await Router.load(base);
  const resolve = resolver(osm, aton);
  const waterSel = $('water-mode'), tripSel = $('trip-select'), planner = $('planner');
  waterSel.hidden = tripSel.hidden = false;
  waterSel.value = state.waterMode;
  waterSel.addEventListener('change', () => { state.waterMode = waterSel.value; savePrefs({ waterMode: state.waterMode }); map.setStyle(style(), { diff: false }); });

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
  // --- debug: the router's water grid as an image on the map
  const gridOn = $('grid-on');
  $('grid-toggle').hidden = !router;
  const drawGrid = () => {
    if (map.getLayer('navgrid-debug')) map.removeLayer('navgrid-debug');
    if (map.getSource('navgrid-debug')) map.removeSource('navgrid-debug');
    if (!gridOn.checked || !router) return;
    map.addSource('navgrid-debug', { type: 'image', ...router.debugImage() });
    map.addLayer({ id: 'navgrid-debug', type: 'raster', source: 'navgrid-debug',
      paint: { 'raster-resampling': 'nearest', 'raster-opacity': 0.85, 'raster-fade-duration': 0 } }, 'trip-casing');
  };
  gridOn.addEventListener('change', drawGrid);
  const redrawGridSoon = () => { if (gridOn.checked) setTimeout(drawGrid, 50); };
  tripSel.addEventListener('change', redrawGridSoon);
  $('pl-buf').addEventListener('input', redrawGridSoon);
  map.on('click', redrawGridSoon);

  // --- NOAA SFBOFS currents: pale moving streaks, time slider
  const flowData = await fetch(`${base}/data/currents-sfbofs.json`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (flowData) {
    const slider = $('flow-time'), label = $('flow-label'), onBox = $('flow-on'), colourBox = $('flow-colour');
    $('flow-toggle').hidden = false;
    // streaks sit above water, ripples and coast, below piers, roads, routes, buoys and every label.
    // No frozen state: shown means moving.
    const flowKey = 'trail-cartography:flow:v2'; // bump when DEFAULTS change
    const savedFlow = (() => { try { return JSON.parse(localStorage.getItem(flowKey) || '{}'); } catch { return {}; } })();
    const flow = new FlowLayer(map, flowData, { beforeId: 'road', speedBeforeId: 'depth', params: savedFlow, isWater: router ? (lng, lat) => router.isWater(lng, lat) : null, onTime: (t) => { slider.value = t; label.innerHTML = timeLabel(flowData, t); } });
    slider.max = flowData.times.length - 1;
    flow.setTime(flow.t);
    // Now is only useful once you've moved away from now
    const nowBtn = $('flow-now'), nowI = flow.nowIndex();
    const syncNow = () => { nowBtn.disabled = Math.abs(+slider.value - nowI) < 0.5; };
    slider.addEventListener('input', () => { flow.setTime(+slider.value); syncNow(); });
    nowBtn.addEventListener('click', () => { flow.setTime(nowI); syncNow(); });
    // ticks at each local midnight with the day name, plus a mark for "now"
    {
      const n = flowData.times.length - 1, pct = (i) => `${(i / n) * 100}%`;
      let html = `<i class="now" style="left:${pct(nowI)}"></i>`;
      // one label per local day, centred on that day's stretch of the slider (partial days too, if ≥ 4 h)
      const days = [];
      flowData.times.forEach((t, i) => {
        const d = new Date(t), key = d.toDateString();
        if (d.getHours() === 0 && i > 0) html += `<i style="left:${pct(i)}"></i>`;
        if (!days.length || days[days.length - 1].key !== key) days.push({ key, from: i, to: i, name: d.toLocaleDateString([], { weekday: 'short' }) });
        else days[days.length - 1].to = i;
      });
      for (const d of days) if (d.to - d.from >= 4) html += `<span style="left:${pct((d.from + d.to) / 2)}">${d.name}</span>`;
      $('flow-ticks').innerHTML = html;
    }
    syncNow();
    const show = (on) => { onBox.checked = on; $('flow-panel').hidden = !on; flow.setVisible(on); };
    onBox.addEventListener('change', () => { show(onBox.checked); savePrefs({ currents: onBox.checked }); });
    colourBox.checked = prefs.colour; flow.setColour(prefs.colour);
    colourBox.addEventListener('change', () => { flow.setColour(colourBox.checked); savePrefs({ colour: colourBox.checked }); });
    show(prefs.currents);

    // --- tuning panel: every streak knob live; "Copy settings" gives values to hard-code
    const SLIDERS = [
      ['density', 'Density', 0.2, 3, 0.05], ['zoomedOut', 'Thin when zoomed out', 0, 1.5, 0.05],
      ['speed', 'Speed', 50, 1200, 10], ['zoomEase', 'Calm when zoomed in', 0, 1, 0.05],
      ['compress', 'Slow-water boost (lower = more)', 0.2, 1, 0.05], ['trail', 'Trail length', 0.8, 0.99, 0.005],
      ['life', 'Particle life', 20, 200, 5], ['opacity', 'Opacity', 0.2, 2, 0.05], ['width', 'Width', 0.15, 2.5, 0.05],
    ];
    const HELP = {
      density: 'how many streaks on screen', zoomedOut: 'fewer streaks as you zoom out',
      speed: 'how fast streaks move (× real speed)', zoomEase: 'slow the speed-up as you zoom in',
      compress: 'lower = weak currents move relatively more', trail: 'how long the fading tail is; faster water already gets longer tails',
      life: 'how long one streak lives before it restarts somewhere else (low = more flicker, high = long journeys)',
      opacity: 'brightness of streaks', width: 'line thickness',
    };
    const box = $('tuner-sliders');
    const render = () => {
      box.innerHTML = `<label title="darken all the water so white streaks read better">Water tone<span id="tv-waterShade">${prefs.waterShade}</span><input type="range" data-shade min="0" max="0.45" step="0.01" value="${prefs.waterShade}"></label>` +
        SLIDERS.map(([k, label, min, max, step]) =>
        `<label title="${HELP[k] || ''}">${label}<span id="tv-${k}">${flow.p[k]}</span><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${flow.p[k]}"></label>`).join('');
    };
    render();
    const persist = () => { try { localStorage.setItem(flowKey, JSON.stringify(flow.p)); } catch {} };
    box.addEventListener('input', (ev) => {
      if ('shade' in ev.target.dataset) {
        const v = +ev.target.value; $('tv-waterShade').textContent = v; savePrefs({ waterShade: v });
        if (map.getLayer('water-shade')) map.setPaintProperty('water-shade', 'fill-opacity', v);
        return;
      }
      const k = ev.target.dataset.k; if (!k) return;
      const v = +ev.target.value; $(`tv-${k}`).textContent = v; flow.setParams({ [k]: v }); persist();
    });
    $('flow-tune').addEventListener('click', () => { $('tuner').hidden = !$('tuner').hidden; });
    $('tuner-reset').addEventListener('click', () => {
      flow.setParams({ ...FLOW_DEFAULTS }); persist();
      const shade = cfg.defaults?.waterShade ?? 0; savePrefs({ waterShade: shade });
      if (map.getLayer('water-shade')) map.setPaintProperty('water-shade', 'fill-opacity', shade);
      render();
    });
    $('tuner-copy').addEventListener('click', async () => {
      const txt = JSON.stringify({ ...flow.p, waterShade: prefs.waterShade }, null, 1);
      $('tuner-out').hidden = false; $('tuner-out').textContent = txt;
      try { await navigator.clipboard.writeText(txt); $('tuner-copy').textContent = 'Copied ✓'; } catch {}
    });
    window.flow = flow;
  }

  // a full style reload (Web/Paper, water switch) drops the route data and debug grid: put them back
  map.on('style.load', () => { map.getSource('trips')?.setData(state.trip); redrawGridSoon(); });
}

// --- show/hide all the working controls, to see the map clean
const uiBtn = document.getElementById('ui-toggle');
const setClean = (on) => { document.body.classList.toggle('clean', on); uiBtn.textContent = on ? 'Show controls' : 'Hide controls'; uiBtn.setAttribute('aria-pressed', on); };
uiBtn.addEventListener('click', () => { const on = !document.body.classList.contains('clean'); setClean(on); savePrefs({ clean: on }); });
setClean(!!prefs.clean);

window.map = map; // for poking at in devtools
