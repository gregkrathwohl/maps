// New map: frame an area on a plain base map, name it, and the dev server builds a place from
// OpenStreetMap (place.json + data/osm.geojson), then opens it in the editor.
import * as maplibregl from 'maplibre-gl';

const MAX_KM = 25;   // longest side; bigger areas need tiled data (see ROADMAP)
const MIN_KM = 1;
const $ = (id) => document.getElementById(id);

const map = new maplibregl.Map({
  container: 'map', style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [-122.53, 37.85], zoom: 11.5, hash: true, attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'bottom-right');

// the frame sits in the free space left of the card
const frame = $('frame');
const layoutFrame = () => {
  const card = $('card').getBoundingClientRect();
  const narrow = innerWidth < 700;
  const left = 40, top = narrow ? card.bottom + 50 : 60;
  const right = narrow ? innerWidth - 40 : card.left - 40, bottom = innerHeight - 40;
  Object.assign(frame.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
  update();
};

const km = (bbox) => {
  const [w, s, e, n] = bbox, lat = ((s + n) / 2) * Math.PI / 180;
  return [(e - w) * 111.32 * Math.cos(lat), (n - s) * 110.57];
};
const frameBBox = () => {
  const r = frame.getBoundingClientRect(), m = $('map').getBoundingClientRect();
  const nw = map.unproject([r.left - m.left, r.top - m.top]), se = map.unproject([r.right - m.left, r.bottom - m.top]);
  return [nw.lng, se.lat, se.lng, nw.lat].map(v => +v.toFixed(5));
};
let ok = false;
function update() {
  const [wk, hk] = km(frameBBox());
  const long = Math.max(wk, hk);
  ok = long <= MAX_KM && Math.min(wk, hk) >= MIN_KM;
  frame.classList.toggle('bad', !ok);
  $('dims').textContent = `${wk.toFixed(1)} × ${hk.toFixed(1)} km` +
    (long > MAX_KM ? ` · zoom in (max ${MAX_KM} km)` : Math.min(wk, hk) < MIN_KM ? ' · zoom out' : '');
  $('create').disabled = !ok || busy;
}
map.on('move', update);
map.on('load', layoutFrame);
addEventListener('resize', layoutFrame);

// place search (OpenStreetMap Nominatim)
async function search() {
  const q = $('q').value.trim(); if (!q) return;
  $('results').innerHTML = '<li><small>Searching…</small></li>';
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`);
    const list = await r.json();
    $('results').innerHTML = list.length ? list.map((p, i) =>
      `<li data-i="${i}">${p.name || p.display_name.split(',')[0]}<br><small>${p.display_name}</small></li>`).join('') : '<li><small>Nothing found</small></li>';
    $('results').onclick = (ev) => {
      const li = ev.target.closest('li[data-i]'); if (!li) return;
      const p = list[+li.dataset.i], [s, n, w, e] = p.boundingbox.map(Number);
      const r = frame.getBoundingClientRect();
      map.fitBounds([[w, s], [e, n]], { padding: { left: r.left + 10, top: r.top + 10, right: innerWidth - r.right + 10, bottom: innerHeight - r.bottom + 10 }, maxZoom: 15 });
      if (!$('name').value) $('name').value = p.name || '';
      $('results').innerHTML = '';
    };
  } catch (e) { $('results').innerHTML = `<li><small>Search failed: ${e.message}</small></li>`; }
}
$('go').addEventListener('click', search);
$('q').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); search(); } });

// create: the server writes the place and pulls OSM (10–60 s), then we open the editor
let busy = false;
$('card').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!ok || busy) return;
  busy = true; update();
  const t0 = Date.now();
  const tick = setInterval(() => { $('msg').textContent = `Downloading OpenStreetMap data… ${Math.round((Date.now() - t0) / 1000)} s`; }, 500);
  $('msg').classList.remove('err');
  try {
    const r = await fetch('/api/new', { method: 'POST', body: JSON.stringify({
      name: $('name').value.trim(), bbox: frameBBox(), center: map.getCenter().toArray().map(v => +v.toFixed(5)), zoom: +map.getZoom().toFixed(2) }) });
    if (!r.ok) throw new Error(await r.text());
    const { id } = await r.json();
    location.href = `/?place=${id}`;
  } catch (e) {
    clearInterval(tick); busy = false; update();
    $('msg').textContent = `Couldn't create the map: ${e.message.slice(0, 200)}`; $('msg').classList.add('err');
  }
});
