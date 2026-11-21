import * as maplibregl from 'maplibre-gl';
import mlcontour from 'maplibre-contour';
import { PALETTES, PRESETS, MUTED_TOWNS } from './palette.js';
import { buildStyle, outsideMask, vegOpacity, SHADE_PRESETS, shadePaint } from './style.js';
import { buildBayStyle } from './bay-style.js';
import { addImages, waterBumps } from './patterns.js';
import { LabelLayer, STYLES } from './labels.js';
import { exportPDF, inlineClone } from './pdf.js';
import { placePeaks } from './peaks.js';
import { Router } from './router.js';
import { resolver, buildTrip, summary, fmtDist, UNITS } from './trips.js';
import { FlowLayer, timeLabel, DEFAULTS as FLOW_DEFAULTS } from './flow.js';
import { Relief, LOOK as RELIEF_LOOK, refresh as refreshRelief } from './relief.js';

window.maplibregl = maplibregl;
const place = new URLSearchParams(location.search).get('place') || 'marin-headlands';
const base = `places/${place}`;

const empty = { type: 'FeatureCollection', features: [] };
const optional = (url) => fetch(url).then(r => (r.ok ? r.json() : empty)).catch(() => empty);
const [cfg, osm, labels, currents, routes, aton, coastLines, ripples, trips, cpad, trailAccess] = await Promise.all([
  fetch(`${base}/place.json`).then(r => r.json()),
  fetch(`${base}/data/osm.geojson`).then(r => r.json()),
  fetch(`${base}/labels.json`).then(r => (r.ok ? r.json() : [])),
  optional(`${base}/data/currents.geojson`),
  optional(`${base}/data/routes.geojson`),
  optional(`${base}/data/aton.geojson`),
  optional(`${base}/data/coast.geojson`),
  optional(`${base}/data/ripples.geojson`),
  fetch(`${base}/trips.json`).then(r => (r.ok ? r.json() : [])).catch(() => []),
  optional(`${base}/data/cpad.geojson`),
  optional(`${base}/data/trail-access.geojson`),
]);
// place.json "townNames": places OSM files as hamlets that the map should still name when zoomed out (Bolinas)
for (const f of osm.features) if (f.properties.place === 'hamlet' && cfg.townNames?.includes(f.properties.name)) f.properties.place = 'village';
// public land from CPAD (scripts/fetch-cpad.mjs) fills OSM's gaps: open and restricted-access holdings join the
// open space (unnamed here, so they never add park labels; `access` is kept for styling)
for (const f of cpad.features) if (f.geometry && f.properties.access !== 'No Public Access')
  osm.features.push({ type: 'Feature', geometry: f.geometry, properties: { boundary: 'protected_area', cpad: 1, access: f.properties.access, unit: f.properties.unit } });
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
document.querySelector('.title-panel').classList.add('ready');
document.querySelector('.key').classList.add('ready');

const names = cfg.boundaries || [cfg.name];
// a merged park outline (new maps write data/boundary.geojson), else the named OSM boundaries
// extent: "bbox" (new maps) = the rectangle you framed; otherwise park outlines (merged file or OSM names)
const merged = cfg.extent === 'bbox' ? empty : await optional(`${base}/data/boundary.geojson`);
const rect = ([w, s, e, n]) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } });
const boundaries = cfg.extent === 'bbox' ? [rect(cfg.bbox)]
  : merged.features.length ? merged.features
  : osm.features.filter(f => f.properties.boundary && names.includes(f.properties.name));
const mask = outsideMask(boundaries);
// paper mode's native scale (lines are 'printed' at this zoom); falls back to the opening zoom
const designZoom = cfg.designZoom ?? cfg.zoom;

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

// settings live in the place's files: place.json "defaults" (+ relief.look), labels.json.
// The editor (dev server only) autosaves there, so a refresh, the Preview tab and the published
// site all show exactly what was saved. ?preview renders the published view.
const PREVIEW = new URLSearchParams(location.search).has('preview');
if (PREVIEW) document.body.setAttribute('data-public', '');
const PUBLIC = document.body.hasAttribute('data-public');
const EDITOR = !PUBLIC;
const SAVED_KEYS = ['printBorder', 'preset', 'shade', 'water', 'mode', 'hillshade', 'blender', 'contours', 'terrainDetail', 'veg', 'vegOpacity', 'vegFade', 'waterMode', 'waterShade', 'currents', 'colour'];
const prefs = { mode: 'web', hillshade: false, waterMode: 'ripples', waterShade: 0, currents: true, colour: false, ...(cfg.defaults || {}) };
const $ = (id) => document.getElementById(id);
const status = (t) => { const el = $('ed-status'); if (el) { el.textContent = t; el.classList.toggle('busy', t !== 'Saved'); } };
const postJSON = (url, body) => fetch(url, { method: 'POST', body: JSON.stringify(body) })
  .then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); });
let saveT = 0;
const savePrefs = (patch) => {
  Object.assign(prefs, patch);
  if (!EDITOR) return;
  status('Saving…'); clearTimeout(saveT);
  saveT = setTimeout(() => postJSON(`/api/settings/${place}`, { defaults: Object.fromEntries(SAVED_KEYS.filter(k => prefs[k] !== undefined).map(k => [k, prefs[k]])) })
    .then(() => status('Saved')).catch(e => status(`Save failed: ${e.message}`)), 500);
};
// painterly vegetation tiles: data/veg/veg.json lists each tile's corners (not in the public build yet)
let vegIndex = cfg.vegetation?.index
  ? await fetch(`${base}/${cfg.vegetation.index}`).then(r => (r.ok ? r.json() : null)).catch(() => null) : null;
let vegBase = vegIndex && `${base}/${cfg.vegetation.index.replace(/\/[^/]*$/, '')}`;
// big regions (place.json "towns": "muted"): streets and town land recede so the open space carries the map
const palette = (k) => ({ ...(PALETTES[k] || PALETTES.ecta), ...(cfg.towns === 'muted' ? MUTED_TOWNS : {}) });
let c = palette(prefs.preset);
const SHADE_DEFAULT = { method: 'multidirectional', exaggeration: 0.35, direction: 315, altitude: 45, shadow: '#5d6b5a',
  highlight: '#ffffff', highlightOpacity: 1, accent: '#8a8a7a', land: null, contour: null, contourOpacity: 0.6 };
const state = { printBorder: !!prefs.printBorder, terrainDetail: prefs.terrainDetail || 'normal', water: { texture: 'bumps', strength: 0.05, bumpSize: 0.45, depth: false, isobaths: false, ...(prefs.water || {}) }, shade: { preset: 'style', ...SHADE_DEFAULT, ...(prefs.shade || {}) }, preset: PALETTES[prefs.preset] ? prefs.preset : 'ecta', mode: prefs.mode, hillshade: prefs.hillshade, waterMode: prefs.waterMode, trip: empty,
  blender: !!cfg.relief && prefs.blender !== false, veg: prefs.veg && prefs.veg !== 'off' ? prefs.veg : 'autumn',
  // contours were turned off for the vegetation; if the vegetation can't show (public build), bring them back
  contours: prefs.contours ?? (!prefs.preset || prefs.preset === 'ecta'),
  vegOpacity: prefs.vegOpacity ?? 1, vegFade: prefs.vegFade ?? 0 };
// Blender relief: the grey render, turned into shadows + highlights in a canvas pinned to the
// bbox corners (NW, NE, SE, SW). The look is tunable live and autosaved to place.json.
const reliefLook = { ...RELIEF_LOOK, ...(cfg.relief?.look || {}) };
let relief = null;
if (cfg.relief) {
  const [rw, rs, re, rn] = cfg.relief.bbox;
  const r = await Relief.load(`${base}/${cfg.relief.image}`, cfg.relief.flat).catch(() => null);
  if (r) { r.paint(reliefLook); relief = { r, canvas: r.canvas, opacity: reliefLook.opacity,
    coordinates: [[rw, rn], [re, rn], [re, rs], [rw, rs]] }; }
}
document.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x.dataset.mode === state.mode));
$('hillshade').checked = state.hillshade;
$('print-border').checked = state.printBorder;
$('print-border').addEventListener('change', (ev) => {
  state.printBorder = ev.target.checked; savePrefs({ printBorder: state.printBorder });
  if (map.getLayer('print-border')) map.setLayoutProperty('print-border', 'visibility', state.printBorder ? 'visible' : 'none');
});
// OSM labels to suppress: anything a hand label already covers (or says it replaces)
// ("keepOsm": a ridge or area label that shares its name with a summit leaves the summit's own label alone)
const handNamesOf = () => labels.flatMap(l => [...(l.keepOsm ? [] : [l.text.replace(/\n/g, ' ')]), ...(l.replaces ? [l.replaces] : [])]);
let handNames = handNamesOf();
if (!bay) placePeaks(osm.features, designZoom);
const style = () => (bay ? buildBayStyle : buildStyle)({ printBorder: state.printBorder, c: bay ? undefined : c, osm, access: trailAccess.features.length ? trailAccess : null, mask, currents, routes, aton, coastLines,
  ripples, trips: state.trip, waterMode: state.waterMode, waterShade: prefs.waterShade,
  contourTiles: contourTiles(state.mode), mode: state.mode, designZoom, hillshade: state.hillshade,
  relief, blender: state.blender, handNames, contours: state.contours, parking: cfg.parking !== false, terrainDetail: state.terrainDetail, preset: state.preset, shade: state.shade, water: state.water,
  // the painterly vegetation is its own map style (it clashes with ECTA's red trails)
  veg: vegIndex && state.preset === 'veg' ? { tiles: vegIndex.tiles, base: vegBase, palette: state.veg, opacity: state.vegOpacity, fade: state.vegFade } : null });

// nothing is remembered by the browser: every reload is the map's own defaults (the editor open, docked)
const setCollapsed = (on) => {
  document.body.classList.toggle('editor-open', EDITOR && !on);
  window.__map?.resize();
};
if (EDITOR) setCollapsed(false);

const [w, s, e, n] = cfg.bbox;
const map = new maplibregl.Map({
  container: 'map', style: style(), center: cfg.center, zoom: cfg.zoom ?? designZoom,
  // big regions: a little room to pan past the frame, no more (place.json "margin", degrees)
  maxBounds: cfg.margin != null ? [[w - cfg.margin, s - cfg.margin * 0.7], [e + cfg.margin, n + cfg.margin * 0.7]]
    : [[w - 0.08, s - 0.05], [e + 0.08, n + 0.05]], attributionControl: false,
});
// a #zoom/lat/lng in a link opens there once, then leaves the address, so a reload is the fresh default view
const at = /^#([\d.]+)\/(-?[\d.]+)\/(-?[\d.]+)/.exec(location.hash);
if (at) { map.jumpTo({ zoom: +at[1], center: [+at[3], +at[2]] }); history.replaceState(null, '', location.pathname + location.search); }
// with a margin set, you can't zoom out much past the whole frame either; a fresh visit opens on the frame
if (cfg.margin != null) {
  const fit = () => map.cameraForBounds(cfg.bbox, { padding: 20 })?.zoom;
  const lock = () => { const z = fit(); if (z != null) map.setMinZoom(z - 0.4); };
  lock(); map.on('resize', lock);
  if (!at) map.jumpTo(map.cameraForBounds(cfg.bbox, { padding: 20 }));
}
// title and legend stacked in the bottom-left corner
if (cfg.panels === 'bottom-left') {
  document.body.classList.add('panels-bl');
  const stack = () => { document.querySelector('.title-panel').style.bottom = `${document.querySelector('.key').offsetHeight + 34 + 16}px`; };
  stack(); addEventListener('resize', stack);
}
if (trailAccess.features.length) document.getElementById('k-access').hidden = false;
if (cfg.parking === false) document.querySelector('.key .sw.p')?.closest('.k')?.setAttribute('hidden', '');

// Paper mode on a map with a print layout (place.json "panelBox": [west, south, east, north], a stretch of open
// water inset from the page's corner): the title and legend are part of the print, stacked title over legend and
// scaled to fill that box - a fixed size on the ground, so they zoom with the map like everything else on the
// sheet. Other maps, and web mode, keep them fixed on the screen.
const titleEl = document.querySelector('.title-panel'), keyEl = document.querySelector('.key');
const placePanels = () => {
  const paper = state.mode === 'paper' && !!cfg.panelBox;   // only maps with a print layout
  document.body.classList.toggle('panels-paper', paper);
  if (!paper) { for (const el of [titleEl, keyEl]) el.style.transform = ''; return; }
  const W0 = Math.max(titleEl.offsetWidth, keyEl.offsetWidth), th = titleEl.offsetHeight, kh = keyEl.offsetHeight, gap = 14;
  const at = (x, y, k) => `translate(${x}px, ${y}px) scale(${k})`;
  const [bw, bs, be, bn] = cfg.panelBox, a = map.project([bw, bs]), b = map.project([be, bn]);
  const k = Math.min((b.x - a.x) / W0, (a.y - b.y) / (th + gap + kh));   // as big as fits, both ways
  keyEl.style.transform = at(a.x, a.y - kh * k, k);
  titleEl.style.transform = at(a.x, a.y - (kh + gap + th) * k, k);
};
map.on('move', placePanels); addEventListener('resize', placePanels); placePanels();
window.__map = map;
map.on('styleimagemissing', () => {}); // images are added below
map.on('style.load', () => addImages(map, c, { bumpSize: state.water.bumpSize ?? 0.45 }));
map.addControl(new maplibregl.ScaleControl({ unit: 'imperial', maxWidth: 160 }), 'bottom-right');
map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'bottom-right');

// Download PDF (trail maps): the whole sheet in paper mode at the native zoom, at print resolution
if (!bay) {
  const btn = document.createElement('button');
  btn.className = 'pdf-btn'; btn.type = 'button'; btn.title = 'Download the whole map as a print-resolution PDF';
  btn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M3 13h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span>PDF</span>';
  map.addControl({ onAdd: () => { const d = document.createElement('div'); d.className = 'maplibregl-ctrl maplibregl-ctrl-group'; d.appendChild(btn); return d; }, onRemove: () => {} }, 'bottom-right');
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    const label = btn.querySelector('span'), was = state.mode;
    try {
      state.mode = 'paper'; const st = style(); state.mode = was;
      // the sheet is all inside the page: no outside wash, print border or page edge
      st.layers = st.layers.filter(l => !['outside', 'print-border', 'page-edge'].includes(l.id));
      // the title and legend laid out as they are on the paper sheet
      const hadPaper = document.body.classList.contains('panels-paper');
      document.body.classList.add('panels-paper');
      const overlays = (g) => {
        const out = [], W0 = Math.max(titleEl.offsetWidth, keyEl.offsetWidth), th = titleEl.offsetHeight, kh = keyEl.offsetHeight, gap = 14;
        let x, y, k;
        if (cfg.panelBox) {
          const [bw, bs, be, bn] = cfg.panelBox, a = g.px(bw, bs), b = g.px(be, bn);
          k = Math.min((b[0] - a[0]) / W0, (a[1] - b[1]) / (th + gap + kh)); x = a[0]; y = a[1];
        } else { k = 1; x = 24; y = g.H - 24; }
        out.push({ el: inlineClone(titleEl), transform: `translate(${x}px,${y - (kh + gap + th) * k}px) scale(${k})`, w: titleEl.offsetWidth });
        out.push({ el: inlineClone(keyEl), transform: `translate(${x}px,${y - kh * k}px) scale(${k})`, w: keyEl.offsetWidth });
        // hand-placed labels at their paper size (1:1 at the native zoom)
        const tmp = document.createElement('div'); tmp.style.cssText = 'position:fixed;left:-99999px;top:0';
        document.body.appendChild(tmp);
        for (const l of labels) {
          const el = document.createElement('div'); el.className = 'hand-label'; tmp.appendChild(el);
          LabelLayer.prototype.paint.call(layer, el, l);
          el.style.fontSize = `${l.size || 13}px`;
          if (el.classList.contains('locator')) el.style.width = el.style.height = `${(l.size || 13) * 1.7}px`;
          const [px, py] = g.px(l.at[0], l.at[1]);
          out.push({ el: inlineClone(el), transform: `translate(${px}px,${py}px) rotate(${l.rotate || 0}deg) translate(-50%,-50%)` });
        }
        tmp.remove();
        return out;
      };
      const res = await exportPDF({
        style: st, bbox: cfg.bbox, designZoom, overlays,
        addImages: (m) => addImages(m, c, { bumpSize: state.water.bumpSize ?? 0.45 }),
        onProgress: (t) => { label.textContent = t; },
        filename: `${place}.pdf`,
      }).finally(() => { if (!hadPaper) document.body.classList.remove('panels-paper'); });
      console.log('PDF', res);
    } catch (err) { console.error(err); alert(`PDF failed: ${err.message}`); }
    finally { state.mode = was; label.textContent = 'PDF'; btn.disabled = false; }
  });
}
map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: '© OpenStreetMap contributors' }));
// start the attribution collapsed to its ⓘ button (MapLibre opens it on wide screens)
map.once('load', () => document.querySelectorAll('.maplibregl-ctrl-attrib').forEach(el => { el.classList.remove('maplibregl-compact-show'); el.removeAttribute('open'); }));

const zoomEl = $('zoom');
const showZoom = () => (zoomEl.textContent = `z${map.getZoom().toFixed(1)}`);
map.on('zoom', showZoom); showZoom();

// --- editor chrome: name, preview, collapse
$('ed-name').textContent = `${cfg.name} ${cfg.subtitle || ''}`.trim();
$('preview').addEventListener('click', () => window.open(`${location.pathname}?place=${place}&preview#${map.getZoom().toFixed(2)}/${map.getCenter().lat.toFixed(5)}/${map.getCenter().lng.toFixed(5)}`, '_blank'));
$('ed-collapse').addEventListener('click', () => setCollapsed(true));
const setFloat = (on) => { document.body.classList.toggle('ed-float', on); map.resize(); };
setFloat(false);
$('ed-float').addEventListener('click', () => setFloat(!document.body.classList.contains('ed-float')));
$('ed-open').addEventListener('click', () => setCollapsed(false));
// legend + panels follow the style preset (bay maps keep their own key)
const ectaKey = document.querySelector('.key').innerHTML;
const npsKey = `
  <div class="k"><i class="sw nps-t solid"></i>Hiking, horses, bikes</div>
  <div class="k"><i class="sw nps-t horse"></i>Hiking and horses</div>
  <div class="k"><i class="sw nps-t bike"></i>Hiking and bikes</div>
  <div class="k"><i class="sw nps-t foot"></i>Hiking only</div>
  <div class="k"><i class="sw nps-road"></i>Road</div>
  <div class="k"><i class="sw nps-hwy"></i>Highway</div>
  <div class="k"><i class="sw fill nps-park"></i>Park land</div>
  <div class="k"><i class="sw contour"></i>Contour, 20 ft</div>
  <div class="k"><i class="sw p">P</i>Parking</div>
  <div class="k"><i class="sw nps-peak"></i>Peak, elevation in feet</div>
  <p class="src">Data: OpenStreetMap contributors, OpenFreeMap, Mapzen/AWS Terrain Tiles. Style after National Park Service maps (Harpers Ferry Center).</p>`;
const applyPreset = () => {
  document.body.classList.toggle('preset-nps', state.preset === 'nps');
  document.body.classList.toggle('preset-veg', state.preset === 'veg');
  const vs = document.getElementById('veg-sec'); if (vs) vs.hidden = bay || state.preset !== 'veg';
  if (!bay) document.querySelector('.key').innerHTML = state.preset === 'nps' ? npsKey : ectaKey;
};
applyPreset();
const syncKey = () => { const k = document.querySelector('.key .sw.contour')?.closest('.k'); if (k) k.hidden = !state.contours; };
const restyle = () => { syncKey(); map.setStyle(style(), { diff: false }); };
syncKey();

// --- labels
const insp = $('inspector');
$('i-style').innerHTML = Object.keys(STYLES).map(k => `<option>${k}</option>`).join('');
const renderLabelList = () => {
  $('label-count').textContent = labels.length;
  $('label-list').innerHTML = labels.map((l, i) =>
    `<li data-i="${i}" class="${i === layer?.selected ? 'on' : ''}"><span>${l.text.replace(/\n/g, ' ').replace(/</g, '&lt;')}</span><small>${l.style}</small></li>`).join('');
};
let layer = null;
layer = new LabelLayer(map, {
  place, labels, mode: state.mode, designZoom,
  onSelect(l) {
    insp.hidden = !l;
    renderLabelList();
    if (!l) return;
    $('i-text').value = l.text.replace(/\n/g, '\\n');
    $('i-style').value = l.style;
    $('i-size').value = l.size || 13;
    $('i-rotate').value = l.rotate || 0;
    $('i-spacing').value = l.spacing ?? STYLES[l.style]?.spacing ?? 0;
    $('i-minzoom').value = l.minzoom ?? '';
    $('label-list').querySelector('li.on')?.scrollIntoView({ block: 'nearest' });
  },
  onDirty() { status('Saving…'); },
  onSave(ok) { status(ok ? 'Saved' : 'Save failed'); renderLabelList(); refreshAutoLabels(); },
});
renderLabelList();
// a name taken over by a hand label disappears from the automatic (OSM) labels
function refreshAutoLabels() {
  const next = handNamesOf();
  if (next.join('\u0001') === handNames.join('\u0001')) return;
  handNames = next;
  for (const l of style().layers) if (l.type === 'symbol' && l.filter && map.getLayer(l.id)) map.setFilter(l.id, l.filter);
}
// click an automatic name on the map (peak, trail, road, fort…) to turn it into a hand label you can
// move, resize, rotate or restyle. Its automatic copies hide; delete the hand label to bring them back.
const AUTO = { 'peak-label': 'feature', 'battery-label': 'feature', 'trail-label': 'feature', 'road-label': 'feature' };
function adopt(ev) {
  const layers = Object.keys(AUTO).filter(id => map.getLayer(id));
  const p = ev.point, hits = map.queryRenderedFeatures([[p.x - 6, p.y - 6], [p.x + 6, p.y + 6]], { layers });
  const f = hits.find(h => h.properties.name);
  if (!f) return false;
  const at = f.geometry.type === 'Point' ? f.geometry.coordinates : [ev.lngLat.lng, ev.lngLat.lat];
  const line = f.layer.id === 'trail-label' || f.layer.id === 'road-label';
  status('Saving…');
  // point names wrap like the automatic ones (~10 characters a line); line names stay on one line
  const wrap = (t) => t.split(' ').reduce((ls, w) => { const l = ls[ls.length - 1];
    if (l && (l + ' ' + w).length <= 10) ls[ls.length - 1] = l + ' ' + w; else ls.push(w); return ls; }, []).join('\n');
  layer.add([+at[0].toFixed(5), +at[1].toFixed(5)], { text: line ? f.properties.name : wrap(f.properties.name), style: AUTO[f.layer.id],
    size: line ? 10.5 : 11.5, replaces: f.properties.name });
  return true;
}
const setEditing = (on) => { $('edit').checked = on; layer.setEditing(on); };
const edit = (key, conv = (v) => v) => (ev) => { if (layer.selected == null) return; status('Saving…'); layer.update(layer.selected, { [key]: conv(ev.target.value) }); };
$('i-text').addEventListener('input', edit('text', v => v.replace(/\\n/g, '\n')));
$('i-style').addEventListener('change', edit('style'));
$('i-size').addEventListener('input', edit('size', Number));
$('i-rotate').addEventListener('input', edit('rotate', Number));
$('i-spacing').addEventListener('input', edit('spacing', Number));
$('i-minzoom').addEventListener('change', edit('minzoom', v => (v === '' ? undefined : Number(v))));
$('i-delete').addEventListener('click', () => { if (layer.selected != null) { status('Saving…'); layer.remove(layer.selected); } });
$('edit').addEventListener('change', (ev) => setEditing(ev.target.checked));
$('label-add').addEventListener('click', () => {
  setEditing(true); status('Saving…');
  const p = map.getCenter(); layer.add([+p.lng.toFixed(5), +p.lat.toFixed(5)]);
});
$('label-list').addEventListener('click', (ev) => {
  const li = ev.target.closest('li'); if (!li) return;
  setEditing(true); const i = +li.dataset.i; layer.select(i);
  const at = labels[i].at, b = map.getBounds();
  if (!b.contains(at)) map.easeTo({ center: at });
});
map.on('click', (ev) => {
  if (layer.editing && ev.originalEvent.altKey) { status('Saving…'); layer.add([+ev.lngLat.lng.toFixed(5), +ev.lngLat.lat.toFixed(5)]); }
  else if (layer.editing && !adopt(ev)) layer.select(null);
});

// --- view + terrain
document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
  state.mode = b.dataset.mode; savePrefs({ mode: state.mode });
  document.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x === b));
  restyle();
  layer.setMode(state.mode);
  placePanels();
}));
$('preset').innerHTML = PRESETS.map(([id, name]) => `<option value="${id}">${name}</option>`).join('');
$('preset').value = state.preset;
$('preset').closest('label').hidden = bay;
$('preset').addEventListener('change', (ev) => {
  state.preset = ev.target.value; c = palette(state.preset);
  // NPS maps show relief, not contours
  state.contours = state.preset === 'ecta'; $('contours').checked = state.contours;   // NPS + vegetation: relief, no contours
  savePrefs({ preset: state.preset, contours: state.contours });
  applyPreset(); restyle();
  // first time a map picks the painted style: start making its vegetation (minutes; progress in the sidebar)
  if (state.preset === 'veg' && !vegIndex) vegJob(true);
});
$('blender').closest('label').hidden = !relief;
$('contours').checked = state.contours;
$('terrain-detail').value = state.terrainDetail;
$('terrain-detail').addEventListener('change', (ev) => { state.terrainDetail = ev.target.value; savePrefs({ terrainDetail: state.terrainDetail }); restyle(); });
// advanced hillshade: presets fill the fields; touching any field makes it "Custom". Applied live.
const shadeRows = () => {
  const s = state.shade;
  $('sh-preset').value = s.preset;
  document.querySelectorAll('[data-sh]').forEach(el => {
    const k = el.dataset.sh, v = s[k] ?? (k === 'land' ? c.openSpace : k === 'contour' ? c.contour : null);
    if (v != null) el.value = v;
  });
  document.querySelectorAll('[data-v]').forEach(el => { el.textContent = s[el.dataset.v] ?? ''; });
  for (const k of ['land', 'contour']) {
    document.querySelector(`[data-sh-on="${k}"]`).checked = !!s[k];
    document.querySelectorAll(`[data-row="${k}"]`).forEach(r => (r.hidden = !s[k]));
  }
  $('sh-note').hidden = !(relief && state.blender);
  $('shade-adv').hidden = !state.hillshade;
};
const applyShadeLive = (structural) => {
  savePrefs({ shade: state.shade });
  if (structural || state.shade.preset === 'style') { restyle(); return; }
  if (map.getLayer('hillshade')) for (const [k, v] of Object.entries(shadePaint(state.shade))) map.setPaintProperty('hillshade', k, v);
  if (map.getLayer('open-space') && state.shade.land) map.setPaintProperty('open-space', 'fill-color', state.shade.land);
  if (state.shade.contour) for (const id of ['contour', 'contour-index']) if (map.getLayer(id)) {
    map.setPaintProperty(id, 'line-color', state.shade.contour); map.setPaintProperty(id, 'line-opacity', +state.shade.contourOpacity);
  }
};
$('sh-preset').addEventListener('change', (ev) => {
  const p = ev.target.value;
  state.shade = p === 'custom' ? { ...state.shade, preset: 'custom' }
    : { ...SHADE_DEFAULT, ...(SHADE_PRESETS[p] || {}), preset: p };
  // the Google look relies on contours, so switch them on with it
  if (p === 'google' && !state.contours) { state.contours = true; $('contours').checked = true; savePrefs({ contours: true }); }
  shadeRows(); applyShadeLive(true);
});
document.querySelectorAll('[data-sh]').forEach(el => el.addEventListener('input', () => {
  const k = el.dataset.sh;
  state.shade = { ...state.shade, preset: 'custom', [k]: el.type === 'range' ? +el.value : el.value };
  shadeRows(); applyShadeLive(false);
}));
document.querySelectorAll('[data-sh-on]').forEach(el => el.addEventListener('change', () => {
  const k = el.dataset.shOn;
  state.shade = { ...state.shade, preset: 'custom', [k]: el.checked ? (k === 'land' ? c.openSpace : c.contour) : null };
  shadeRows(); applyShadeLive(!el.checked);   // turning a tint off needs the style's own colour back
}));
shadeRows();
$('sh-reset').addEventListener('click', () => { state.shade = { preset: 'style', ...SHADE_DEFAULT }; shadeRows(); applyShadeLive(true); });
// water (trail maps): texture, depth tint, depth lines
document.querySelectorAll('[data-trailwater]').forEach(el => (el.hidden = bay));
$('water-h').hidden = false;
$('w-texture').value = state.water.texture || '';
$('w-depth').checked = !!state.water.depth;
$('w-isobaths').checked = !!state.water.isobaths;
const setWater = (patch) => { state.water = { ...state.water, ...patch }; savePrefs({ water: state.water }); restyle(); };
$('w-texture').addEventListener('change', (ev) => { setWater({ texture: ev.target.value }); syncBumpRows(); });
// bumpy water: strength (live opacity) and lump size (regenerates the tile in place)
const syncBumpRows = () => {
  document.querySelectorAll('[data-bumps]').forEach(el => (el.hidden = bay || state.water.texture !== 'bumps'));
  $('w-strength').value = state.water.strength ?? 0.05; $('w-strength-v').textContent = (+$('w-strength').value).toFixed(2);
  $('w-bump').value = state.water.bumpSize ?? 0.45; $('w-bump-v').textContent = (+$('w-bump').value).toFixed(2);
};
syncBumpRows();
let bumpT = 0;
const saveWater = (patch) => { state.water = { ...state.water, ...patch }; savePrefs({ water: state.water }); syncBumpRows(); };
$('w-strength').addEventListener('input', (ev) => {
  saveWater({ strength: +ev.target.value });
  if (map.getLayer('water-texture')) map.setPaintProperty('water-texture', 'fill-opacity', state.water.strength);
});
$('w-bump').addEventListener('input', (ev) => {
  saveWater({ bumpSize: +ev.target.value });
  clearTimeout(bumpT); bumpT = setTimeout(() => { if (map.hasImage('water-bumps')) map.updateImage('water-bumps', waterBumps(state.water.bumpSize)); }, 120);
});
$('w-depth').addEventListener('change', (ev) => setWater({ depth: ev.target.checked }));
$('w-isobaths').addEventListener('change', (ev) => setWater({ isobaths: ev.target.checked }));
// terrain switches only flip layer visibility: no reload
const vis = (id, on) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
const syncTerrain = () => {
  vis('relief', state.hillshade && state.blender);
  vis('hillshade', state.hillshade && !(relief && state.blender));
  for (const id of ['contour', 'contour-index', 'contour-label']) vis(id, state.contours);
  syncKey(); if (relief && state.hillshade && state.blender) refreshRelief(map);
};
$('contours').addEventListener('change', (ev) => { state.contours = ev.target.checked; savePrefs({ contours: state.contours }); syncTerrain(); });
const showVal = (id, v) => { const el = $(`${id}-v`); if (el) el.textContent = (+v).toFixed(2); };
// vegetation: palette + opacity when the tiles exist; a button to make them (several minutes, dev server)
const setupVeg = () => {
  $('veg-controls').hidden = !vegIndex;
  $('veg-go').textContent = vegIndex ? 'Regenerate vegetation' : 'Generate vegetation';
  if (!vegIndex) return;
  $('veg').innerHTML = vegIndex.palettes.map(p => `<option value="${p}">${p[0].toUpperCase() + p.slice(1)}</option>`).join('');
  if (!vegIndex.palettes.includes(state.veg)) state.veg = vegIndex.palettes[0];
  $('veg').value = state.veg;
};
setupVeg();
$('veg').addEventListener('change', (ev) => { state.veg = ev.target.value; savePrefs({ veg: state.veg }); restyle(); });
// opacity + zoomed-out fade, live (no style rebuild)
for (const [id, key] of [['veg-opacity', 'vegOpacity'], ['veg-fade', 'vegFade']]) {
  $(id).value = state[key]; showVal(id, state[key]);
  $(id).addEventListener('input', (ev) => {
    state[key] = +ev.target.value; showVal(id, state[key]); savePrefs({ [key]: state[key] });
    const op = vegOpacity({ opacity: state.vegOpacity, fade: state.vegFade });
    for (const l of map.getStyle().layers) if (l.id.startsWith('veg-')) map.setPaintProperty(l.id, 'raster-opacity', op);
  });
}
let vegWatching = false;
const vegJob = async (start) => {
  const r = await fetch(`/api/vegetation/${place}`, { method: start ? 'POST' : 'GET' }).then(r => r.json()).catch(() => null);
  if (!r) return;
  const secs = r.started ? Math.round((Date.now() - r.started) / 1000) : 0;
  if (r.running) {
    vegWatching = true; $('veg-go').disabled = true;
    $('veg-status').textContent = r.total ? `Rendering tile ${Math.min(r.done + 1, r.total)} of ${r.total}… ${secs} s`
      : `Downloading aerial imagery… ${secs} s`;
    setTimeout(() => vegJob(false), 3000);
    return;
  }
  $('veg-go').disabled = false;
  if (r.error) { $('veg-status').textContent = `Failed: ${r.error.slice(-160)}`; return; }
  if (!vegWatching) return;   // finished before this page opened: nothing new to load
  vegWatching = false;
  $('veg-status').textContent = `Done in ${Math.round(secs / 60)} min`;
  const c2 = await fetch(`${base}/place.json`, { cache: 'reload' }).then(r => r.json());
  cfg.vegetation = c2.vegetation;
  vegIndex = await fetch(`${base}/${cfg.vegetation.index}`, { cache: 'reload' }).then(r => r.json());
  vegBase = `${base}/${cfg.vegetation.index.replace(/\/[^/]*$/, '')}`;
  setupVeg(); restyle();
};
$('veg-go').addEventListener('click', () => vegJob(true));
vegJob(false);   // a job may already be running (e.g. after a reload)
map.on('style.load', () => refreshRelief(map));
map.on('load', () => refreshRelief(map));
$('relief-tuner').hidden = !relief;
if (relief) {
  const LOOKS = [['shadow', 'Shadow strength', 0, 1, 0.02], ['light', 'Highlight strength', 0, 1, 0.02],
    ['gamma', 'Contrast', 0.3, 2, 0.05], ['opacity', 'Opacity', 0, 1, 0.02]];
  const BAKES = [['sunAz', 'Sun direction (°)', 0, 360, 5], ['sunAlt', 'Sun height (°)', 5, 80, 1],
    ['sunSoft', 'Shadow softness', 0, 20, 0.5], ['sky', 'Sky fill light', 0, 1.5, 0.05],
    ['exag', 'Vertical exaggeration', 0.5, 6, 0.1], ['sunEnergy', 'Sun brightness', 0.5, 8, 0.1]];
  const bake = { exag: 2, sunAlt: 35, sunAz: 315, sunSoft: 3, sky: 0.35, sunEnergy: 3, ...(cfg.relief.bake || {}) };
  const slider = (group, [k, label, min, max, step], v) =>
    `<label class="field">${label}<span id="rv-${k}">${v}</span><input type="range" data-${group}="${k}" min="${min}" max="${max}" step="${step}" value="${v}"></label>`;
  $('rl-look').innerHTML = LOOKS.map(d => slider('look', d, reliefLook[d[0]])).join('') +
    `<label class="field row">Shadow tint <input type="color" data-look="tint" value="${reliefLook.tint}"></label>`;
  $('rl-bake').innerHTML = BAKES.map(d => slider('bake', d, bake[d[0]])).join('');
  let raf = 0, lookT = 0;
  const repaint = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { relief.r.paint(reliefLook); refreshRelief(map); }); };
  $('rl-look').addEventListener('input', (ev) => {
    const k = ev.target.dataset.look; if (!k) return;
    reliefLook[k] = k === 'tint' ? ev.target.value : +ev.target.value;
    if (k !== 'tint') $(`rv-${k}`).textContent = reliefLook[k];
    if (k === 'opacity') { relief.opacity = reliefLook.opacity; if (map.getLayer('relief')) map.setPaintProperty('relief', 'raster-opacity', reliefLook.opacity); }
    else repaint();
    status('Saving…'); clearTimeout(lookT);
    lookT = setTimeout(() => postJSON(`/api/relief/${place}`, { look: reliefLook }).then(() => status('Saved')).catch(e => status(`Save failed: ${e.message}`)), 500);
  });
  $('rl-bake').addEventListener('input', (ev) => { const k = ev.target.dataset.bake; if (!k) return; bake[k] = +ev.target.value; $(`rv-${k}`).textContent = bake[k]; });
  $('rl-go').addEventListener('click', async () => {
    const t0 = Date.now(), tick = setInterval(() => { $('rl-status').textContent = `Rendering… ${Math.round((Date.now() - t0) / 1000)} s`; }, 500);
    $('rl-go').disabled = true;
    try {
      const res = await postJSON(`/api/relief/${place}`, { bake, quick: $('rl-quick').checked });
      cfg.relief.flat = res.flat; cfg.relief.bake = { ...bake };
      await relief.r.reload(`${base}/${cfg.relief.image}`, res.flat);
      relief.r.paint(reliefLook); refreshRelief(map);
      $('rl-status').textContent = `Done in ${Math.round((Date.now() - t0) / 1000)} s`;
    } catch (e) { $('rl-status').textContent = `Failed: ${e.message.slice(0, 120)}`; }
    clearInterval(tick); $('rl-go').disabled = false;
  });
}
$('blender').checked = state.blender;
$('blender').addEventListener('change', (ev) => { state.blender = ev.target.checked; savePrefs({ blender: state.blender }); syncTerrain(); shadeRows(); });
$('hillshade').addEventListener('change', (ev) => { state.hillshade = ev.target.checked; savePrefs({ hillshade: state.hillshade }); syncTerrain(); shadeRows(); });

// --- bay maps: water texture switch, saved routes, route planner
if (bay) {
  const router = await Router.load(base);
  const resolve = resolver(osm, aton);
  const waterSel = $('water-mode'), card = $('routes');
  $('water-row').hidden = false;
  waterSel.value = state.waterMode;
  waterSel.addEventListener('change', () => { state.waterMode = waterSel.value; savePrefs({ waterMode: state.waterMode }); map.setStyle(style(), { diff: false }); });

  // --- routes card: "Create a route" → click stops, see the route and its full length
  const showTrip = (t) => { state.trip = t.geojson; map.getSource('trips')?.setData(t.geojson); };
  const timeFor = (nm) => { const m = Math.round((nm / 3) * 60); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
  // distance unit: nautical miles by default (the water standard)
  let unit = 'nm';
  document.querySelectorAll('[data-unit]').forEach(b => b.addEventListener('click', () => {
    unit = b.dataset.unit; refresh();
  }));
  let sel = null;              // 'plan' while creating a route
  let plan = [];
  const planning = () => sel === 'plan';
  const refresh = () => {
    card.hidden = false;
    $('rt-idle').hidden = planning(); $('rt-plan').hidden = !planning();
    document.body.classList.toggle('planning', planning());
    if (!planning()) { showTrip({ geojson: empty }); return; }
    const t = buildTrip(router, plan, unit); showTrip(t);
    document.querySelectorAll('[data-unit]').forEach(b => b.classList.toggle('on', b.dataset.unit === unit));
    $('pl-hint').hidden = plan.length >= 2;
    $('pl-hint').textContent = plan.length ? 'Now click your next stop.' : 'Click the water to start. Each click adds a stop; legs bend around land.';
    const other = unit === 'nm' ? 'mi' : 'nm';
    $('pl-total').innerHTML = t.legs.length ? `${fmtDist(t.total, unit, 2)}<small>${fmtDist(t.total, other)} · ~${timeFor(t.total)} at 3 kn</small>` : '';
    $('pl-legs').innerHTML = t.legs.length > 1 ? t.legs.map(l => `<li>${l.from || 'Point'} → ${l.to || 'point'} · ${fmtDist(l.nm, unit, 2)}</li>`).join('') : '';
  };
  $('rt-new').addEventListener('click', () => { sel = 'plan'; plan = []; refresh(); });
  $('pl-done').addEventListener('click', () => { sel = null; plan = []; refresh(); });
  $('pl-undo').addEventListener('click', () => { plan.pop(); refresh(); });
  $('pl-clear').addEventListener('click', () => { plan = []; refresh(); });
  refresh();
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
  map.on('click', redrawGridSoon);

  // --- NOAA SFBOFS currents: pale moving streaks, time slider
  const flowData = await fetch(`${base}/data/currents-sfbofs.json`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (flowData) {
    const slider = $('flow-time'), label = $('flow-label'), onBox = $('flow-on'), colourBox = $('flow-colour');
    $('flow-toggle').hidden = false;
    // streaks sit above water, ripples and coast, below piers, roads, routes, buoys and every label.
    // No frozen state: shown means moving.
    const savedFlow = {};   // streak tweaks last until reload (use the tuner's Copy to keep them)
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

    // --- tide curve (NOAA high/low predictions, cosine between them): it IS the time control.
    // Hover to read time + height, click or drag to move the currents to that time.
    const tides = await fetch(`${base}/data/tides.json`).then(r => (r.ok ? r.json() : null)).catch(() => null);
    if (tides?.hilo?.length > 1) {
      const T = flowData.times.map(Date.parse), t0 = T[0], t1 = T[T.length - 1], n = T.length - 1;
      const hl = tides.hilo.map(h => ({ ...h, ms: Date.parse(h.t) }));
      const height = (ms) => {
        const k = hl.findIndex(h => h.ms > ms);
        if (k <= 0) return null;
        const a = hl[k - 1], b = hl[k], f = (ms - a.ms) / (b.ms - a.ms);
        return (a.v + b.v) / 2 + ((a.v - b.v) / 2) * Math.cos(Math.PI * f);
      };
      const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(' ', '').replace(/(am|pm|AM|PM)$/, m => m[0].toLowerCase());
      const xs = Array.from({ length: 241 }, (_, i) => t0 + ((t1 - t0) * i) / 240);
      const hs = xs.map(height);
      const valid = hs.filter(v => v != null), lo = Math.min(...valid), hi = Math.max(...valid);
      const Y = (v) => 11 + (1 - (v - lo) / (hi - lo)) * 20; // plot band y 11–31 of 42
      const X = (ms) => ((ms - t0) / (t1 - t0)) * 1000;
      const pts = xs.map((ms, i) => (hs[i] == null ? null : `${X(ms).toFixed(1)},${Y(hs[i]).toFixed(2)}`)).filter(Boolean);
      const box = $('flow-tide');
      let html = `<svg viewBox="0 0 1000 42" preserveAspectRatio="none">
        <path d="M${pts[0].split(',')[0]},42 L${pts.join(' L')} L${pts[pts.length - 1].split(',')[0]},42 Z" fill="rgba(58,111,151,0.10)"/>
        <polyline points="${pts.join(' ')}" fill="none" stroke="#3a6f97" stroke-width="1.3" vector-effect="non-scaling-stroke"/>
      </svg>`;
      for (const h of hl) if (h.ms >= t0 && h.ms <= t1) {
        html += `<span class="lbl ${h.type === 'H' ? 'h' : 'l'}" style="left:${(X(h.ms) / 10).toFixed(2)}%">${clock(h.ms)}</span>`;
      }
      html += `<div class="cursor" id="tide-cursor"><i></i></div><div class="hover" id="tide-hover" hidden><div class="line"></div><div class="tip"></div></div>`;
      box.innerHTML = html;
      box.parentElement.classList.add('has-tide');
      const cursor = $('tide-cursor'), hover = $('tide-hover');
      const showTide = (t) => {
        const ms = t0 + (t / n) * (t1 - t0), v = height(ms), dv = height(ms + 600e3) - v;
        cursor.style.left = `${(t / n) * 100}%`;
        if (v != null) cursor.querySelector('i').style.top = `${(Y(v) / 42) * 100}%`;
        const sm = label.querySelector('small');
        if (v != null && sm) { sm.textContent = `Tide ${v.toFixed(1)} ft ${dv > 0 ? '↑' : '↓'}`; sm.title = `${dv > 0 ? 'Rising' : 'Falling'} · NOAA prediction for ${tides.name}, ft above MLLW`; }
      };
      const prevOnTime = flow.onTime;
      flow.onTime = (t) => { prevOnTime(t); showTide(t); };
      showTide(flow.t);

      // pointer → time index
      const at = (ev) => { const r = box.getBoundingClientRect(); return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * n; };
      const setFrom = (ev) => { const t = Math.round(at(ev) * 4) / 4; slider.value = t; flow.setTime(t); syncNow(); };
      let dragging = false;
      box.addEventListener('pointerdown', (ev) => { dragging = true; box.setPointerCapture(ev.pointerId); setFrom(ev); });
      box.addEventListener('pointerup', () => { dragging = false; });
      box.addEventListener('pointermove', (ev) => {
        if (dragging) setFrom(ev);
        const t = at(ev), ms = t0 + (t / n) * (t1 - t0), v = height(ms);
        hover.hidden = false;
        hover.style.left = `${(t / n) * 100}%`;
        const day = new Date(ms).toLocaleDateString([], { weekday: 'short' });
        hover.querySelector('.tip').textContent = `${day} ${clock(ms)}${v != null ? ` · ${v.toFixed(1)} ft` : ''}`;
      });
      box.addEventListener('pointerleave', () => { hover.hidden = true; });
    }
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
    const persist = () => {};
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



window.map = map; // for poking at in devtools
