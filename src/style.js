import { OFFSETS as PEAK_OFFSETS } from './peaks.js';
// Builds a MapLibre style in the Ipswich-guide look from:
//   - our own OSM extract (GeoJSON, any zoom we like)
//   - OpenFreeMap vector tiles (ocean/bay water polygons only)
//   - Terrarium DEM tiles (hillshade + contours generated in the browser)
//
// mode: 'web'   = detail appears as you zoom in, lines/text stay readable
//       'paper' = one fixed design at designZoom; everything scales like a
//                 printed sheet under a magnifying glass.

const FONT = { regular: ['Noto Sans Regular'], italic: ['Noto Sans Italic'], bold: ['Noto Sans Bold'] };

// vegetation opacity: full strength from z14 in, fading by `fade` (0–1) toward z12
export const vegOpacity = ({ opacity = 1, fade = 0 }) =>
  ['interpolate', ['linear'], ['zoom'], 12, opacity * (1 - fade), 14, opacity];

// Terrain detail: the DEM tiles are 256 px; telling MapLibre they are smaller makes it load finer zooms
// for the same view (sharper shading, more downloads), larger makes it load coarser ones.
const DEM_TILE = { vcoarse: 1024, coarse: 1024, normal: 256, sharp: 128, extra: 64 };
const DEM_MAXZOOM = { vcoarse: 11 };   // very coarse: also never load anything finer than zoom 11
export function buildStyle({ access = null, printBorder = false, ripples = null, c, osm, mask, contourTiles, mode = 'web', designZoom = 13.5, hillshade = false, relief = null, veg = null, contours = true, parking = true, terrainDetail = 'normal', blender = true, preset = 'ecta', shade = null, water = {}, handNames = [] }) {
  const paper = mode === 'paper';

  // line width / text size that either grows gently (web) or exactly with scale (paper)
  // `k` may be a data expression (e.g. a match on highway) multiplied into every stop
  const W = (base, k = null) => {
    const v = (x) => (k ? ['*', k, x] : x);
    return paper
      ? ['interpolate', ['exponential', 2], ['zoom'], designZoom - 6, v(base / 64), designZoom + 6, v(base * 64)]
      : ['interpolate', ['linear'], ['zoom'], 10, v(base * 0.45), 13, v(base * 0.85), 15, v(base * 1.35), 18, v(base * 2.4)];
  };
  const T = (base) => paper
    ? ['interpolate', ['exponential', 2], ['zoom'], designZoom - 6, base / 64, designZoom + 6, base * 64]
    : ['interpolate', ['linear'], ['zoom'], 11, base * 0.8, 14, base, 17, base * 1.35];
  const minz = (z) => (paper ? 0 : z);

  const hw = (...v) => ['match', ['get', 'highway'], v, true, false];
  const notHand = ['!', ['in', ['coalesce', ['get', 'name'], ''], ['literal', handNames]]];

  // roads closed to private cars (Angel Island's Perimeter Road, park fire roads) read as trails
  const carFree = ['all',
    hw('unclassified', 'service', 'residential', 'tertiary'),
    ['match', ['coalesce', ['get', 'motor_vehicle'], ''], ['no', 'private'], true, false],
    ['!=', ['get', 'foot'], 'no']];
  const trailFilter = ['all',
    ['any', hw('path', 'footway', 'bridleway', 'track', 'steps', 'cycleway'), carFree],
    ['!', ['match', ['coalesce', ['get', 'footway'], ''], ['sidewalk', 'crossing', 'access_aisle'], true, false]],
    ['==', ['geometry-type'], 'LineString'],
  ];
  const informal = ['any',
    ['==', ['get', 'informal'], 'yes'],
    ['match', ['coalesce', ['get', 'access'], ''], ['no', 'private'], true, false],
  ];

  const layers = [
    { id: 'paper', type: 'background', paint: { 'background-color': c.paper } },

    // protected open space: the sage fill that carries the whole Ipswich look
    { id: 'open-space', type: 'fill', source: 'osm',
      filter: ['any',
        ['==', ['get', 'boundary'], 'protected_area'],
        ['==', ['get', 'boundary'], 'national_park'],
        ['match', ['coalesce', ['get', 'leisure'], ''], ['nature_reserve', 'park'], true, false]],
      paint: { 'fill-color': c.openSpace } },
    // developed land inside the park punches back to paper (forts, housing, lots)
    { id: 'developed', type: 'fill', source: 'osm',
      filter: ['any',
        ['match', ['coalesce', ['get', 'landuse'], ''], ['residential', 'commercial', 'industrial', 'retail', 'military', 'construction'], true, false],
        ['==', ['get', 'amenity'], 'parking']],
      paint: { 'fill-color': c.developed || c.paper } },

    // painterly vegetation (scripts/vegetation.py): image tiles clipped to parks, under the relief
    ...(veg ? veg.tiles.map(t => ({ id: `veg-${t.row}-${t.col}`, type: 'raster', source: `veg-${t.row}-${t.col}`,
      paint: { 'raster-resampling': 'linear', 'raster-fade-duration': 0, 'raster-opacity': vegOpacity(veg) } })) : []),

    ...(veg ? [{ id: 'developed-veg', type: 'fill', source: 'osm', filter: ['any',
        ['match', ['coalesce', ['get', 'landuse'], ''], ['residential', 'commercial', 'industrial', 'retail', 'military', 'construction'], true, false],
        ['==', ['get', 'amenity'], 'parking']],
      paint: { 'fill-color': c.outside, 'fill-opacity': c.outsideOpacity } }] : []),

    // Blender relief (pre-rendered, transparent shadows + highlights) or the browser's own
    // both are always in the style; the toggles only flip their visibility (no reload)
    ...(relief ? [{ id: 'relief', type: 'raster', source: 'relief',
      layout: { visibility: hillshade && blender ? 'visible' : 'none' },
      paint: { 'raster-opacity': relief.opacity ?? 0.9, 'raster-resampling': 'linear', 'raster-fade-duration': 0 } }] : []),
    ...[{ id: 'hillshade', type: 'hillshade', source: 'dem',
      layout: { visibility: hillshade && !(relief && blender) ? 'visible' : 'none' },
      paint: { 'hillshade-method': 'multidirectional', 'hillshade-exaggeration': 0.35,
        'hillshade-shadow-color': '#5d6b5a', 'hillshade-highlight-color': '#ffffff', 'hillshade-accent-color': '#8a8a7a' } }],

    { id: 'wetland', type: 'fill', source: 'osm', minzoom: minz(12),
      filter: ['==', ['get', 'natural'], 'wetland'],
      paint: { 'fill-pattern': 'marsh' } },
    { id: 'beach', type: 'fill', source: 'osm', minzoom: minz(11),
      filter: ['match', ['coalesce', ['get', 'natural'], ''], ['beach', 'sand'], true, false],
      paint: { 'fill-pattern': 'stipple' } },

    // contours (feet), generated client-side from DEM tiles
    { id: 'contour', type: 'line', source: 'contours', 'source-layer': 'contours',
      filter: ['==', ['get', 'level'], 0],
      paint: { 'line-color': c.contour, 'line-width': W(0.45), 'line-opacity': 0.75 } },
    { id: 'contour-index', type: 'line', source: 'contours', 'source-layer': 'contours',
      filter: ['>', ['get', 'level'], 0],
      paint: { 'line-color': c.contourIndex, 'line-width': W(0.75), 'line-opacity': 0.85 } },
    { id: 'contour-label', type: 'symbol', source: 'contours', 'source-layer': 'contours', minzoom: minz(14),
      filter: ['>', ['get', 'level'], 0],
      layout: { 'symbol-placement': 'line', 'text-field': ['to-string', ['get', 'ele']], 'text-font': FONT.regular,
        'text-size': T(8.5), 'symbol-spacing': 400 },
      paint: { 'text-color': c.contourIndex, 'text-halo-color': c.openSpace, 'text-halo-width': 1.4 } },

    { id: 'cliff', type: 'line', source: 'osm', minzoom: minz(13),
      filter: ['==', ['get', 'natural'], 'cliff'],
      paint: { 'line-color': c.cliff, 'line-width': W(1.1), 'line-dasharray': [1, 0.6] } },
    { id: 'stream', type: 'line', source: 'osm', minzoom: minz(12),
      filter: ['match', ['coalesce', ['get', 'waterway'], ''], ['stream', 'river', 'ditch', 'drain'], true, false],
      paint: { 'line-color': c.stream, 'line-width': W(0.8) } },

    { id: 'building', type: 'fill', source: 'osm', minzoom: minz(14),
      filter: ['all', ['has', 'building'], ['==', ['geometry-type'], 'Polygon']],
      paint: { 'fill-color': c.building } },
    { id: 'battery', type: 'fill', source: 'osm', minzoom: minz(13),
      // only gun batteries / bunkers get the fill; big historic districts (garrisons, coves) stay open
      filter: ['all', ['match', ['coalesce', ['get', 'historic'], ''], ['fort', 'military'], true, false],
        ['any', ['has', 'building'], ['in', 'Battery', ['coalesce', ['get', 'name'], '']]]],
      paint: { 'fill-color': '#bfb8a6', 'fill-outline-color': '#8c8270' } },

    // roads: Ipswich uses plain dark lines, no casings, weight by class
    { id: 'road-service', type: 'line', source: 'osm', minzoom: minz(13),
      filter: ['all', hw('service'), ['!=', ['get', 'service'], 'parking_aisle'], ['!', carFree]],
      layout: { 'line-cap': 'round' }, paint: { 'line-color': c.service, 'line-width': W(0.7) } },
    { id: 'road-street', type: 'line', source: 'osm',
      filter: ['all', c.throughRoads ? hw('residential', 'living_street') : hw('residential', 'unclassified', 'living_street', 'tertiary'), ['!', carFree]],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.street, 'line-width': W(1.2) } },
    // muted-town maps: neighbourhood streets fade, but the roads you travel by (incl. country roads like
    // Fairfax-Bolinas Rd, tagged tertiary/unclassified) stay dark, a little thinner than the main roads
    { id: 'road-main', type: 'line', source: 'osm',
      filter: c.throughRoads ? ['all', hw('primary', 'secondary', 'primary_link', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified'), ['!', carFree]]
        : hw('primary', 'secondary', 'primary_link', 'secondary_link'),
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': c.road, 'line-width': c.throughRoads ? W(1.8, ['match', ['get', 'highway'], ['tertiary', 'tertiary_link', 'unclassified'], 0.7, 1]) : W(1.8) } },
    { id: 'road-highway-casing', type: 'line', source: 'osm',
      filter: hw('motorway', 'trunk', 'motorway_link', 'trunk_link'),
      paint: { 'line-color': c.road, 'line-width': W(3.4) } },
    { id: 'road-highway', type: 'line', source: 'osm',
      filter: hw('motorway', 'trunk'),
      paint: { 'line-color': c.paper, 'line-width': W(1.6) } },

    // over the vegetation, a soft pale halo lifts the trails off the colour
    ...(veg ? [{ id: 'trail-halo', type: 'line', source: 'osm', minzoom: minz(11), filter: trailFilter,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#fbfaf6', 'line-opacity': 0.55, 'line-width': W(4.2), 'line-blur': W(1.6) } }] : []),

    // trails: the red is the whole point
    { id: 'trail', type: 'line', source: 'osm', minzoom: minz(11),
      filter: ['all', trailFilter, ['!', informal]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': c.trail, 'line-width': W(1.7, ['case', carFree, 1.3, ['match', ['get', 'highway'], 'track', 1.25, 'steps', 0.7, 1]]) } },
    { id: 'trail-informal', type: 'line', source: 'osm', minzoom: minz(13),
      filter: ['all', trailFilter, informal],
      paint: { 'line-color': c.trail, 'line-width': W(1.2), 'line-dasharray': [2.5, 1.5] } },
    // trail stretches on private or closed land (scripts/trail-access.py): a quiet fade laid over the trail,
    // so it reads as 'not really ours' when you look for it, without shouting 'do not enter'
    ...(access ? [{ id: 'trail-access', type: 'line', source: 'access',
      layout: { 'line-cap': 'butt' },
      paint: { 'line-color': c.paper, 'line-width': W(1.6), 'line-opacity': ['match', ['get', 'access'], 'closed', 0.72, 0.58] } }] : []),

    // neighbouring land: one translucent wash, exactly like the guide's grey-out
    { id: 'outside', type: 'fill', source: 'mask', paint: { 'fill-color': c.outside, 'fill-opacity': c.outsideOpacity } },
    { id: 'boundary', type: 'line', source: 'mask',
      paint: { 'line-color': c.boundary, 'line-width': W(1.1), 'line-dasharray': [6, 2, 1, 2] } },

    // water sits above the wash: the guide keeps every bay and ocean blue
    // water from OpenFreeMap tiles (ocean polygons are hard to build from raw coastline)
    { id: 'water', type: 'fill', source: 'ofm', 'source-layer': 'water', paint: { 'fill-color': c.water } },
    { id: 'osm-water', type: 'fill', source: 'osm',
      filter: ['any', ['==', ['get', 'natural'], 'water'], ['==', ['get', 'water'], 'lagoon']],
      paint: { 'fill-color': c.water } },
    // water options: depth tint from the same DEM (Terrarium carries NOAA bathymetry), depth lines,
    // and a hand-drawn wave texture, so the water isn't one flat colour
    ...(water.depth ? [{ id: 'depth', type: 'color-relief', source: 'dem',
      paint: { 'color-relief-opacity': 0.85, 'color-relief-color': ['interpolate', ['linear'], ['elevation'],
        -80, '#6aa3c8', -40, '#86b7d6', -20, '#a2c9e0', -8, '#b8d6e7', -2, '#c9e1eb', -0.3, 'rgba(205,228,236,0)', 0, 'rgba(0,0,0,0)'] } }] : []),
    ...(water.isobaths ? [{ id: 'isobath', type: 'line', source: 'contours', 'source-layer': 'contours',
      filter: ['<', ['get', 'ele'], 0],
      paint: { 'line-color': '#6f9fc0', 'line-width': W(0.4, ['case', ['>', ['get', 'level'], 0], 1.75, 1]), 'line-opacity': 0.5 } }] : []),
    ...(water.texture ? [{ id: 'water-texture', type: 'fill', source: 'ofm', 'source-layer': 'water',
      paint: { 'fill-pattern': water.texture === 'bumps' ? 'water-bumps' : 'waves', 'fill-opacity': water.texture === 'bumps' ? (water.strength ?? 0.05) : 0.8 } }] : []),
    // shore ripples (scripts/coast.mjs + water.mjs): a few quiet lines that follow the coast out to sea,
    // texture for the water without a full set of depth lines
    ...(ripples?.features?.length ? [{ id: 'ripple', type: 'line', source: 'ripples',
      layout: { 'line-join': 'round' },
      paint: { 'line-color': c.waterLine, 'line-width': W(0.55), 'line-opacity': 0.4 } }] : []),
    { id: 'coastline', type: 'line', source: 'osm',
      filter: ['all', ['==', ['get', 'natural'], 'coastline'], ['==', ['geometry-type'], 'LineString']],
      paint: { 'line-color': c.waterLine, 'line-width': W(0.7) } },
    // bridges over water sit above it (the water layer otherwise hides them); the Golden Gate in its own orange
    { id: 'bridge', type: 'line', source: 'osm',
      filter: ['all', ['==', ['get', 'bridge'], 'yes'], hw('motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link')],
      layout: { 'line-cap': 'butt' },
      paint: { 'line-color': ['case', ['==', ['get', 'name'], 'Golden Gate Bridge'], '#c0362c', c.road], 'line-width': W(2.6) } },
    // paper mode is a print: the page edge runs all the way round, out over the water too, and with
    // "Print border" on everything beyond it is (nearly) blank paper, the way the sheet would come off the printer
    ...(paper ? [
      { id: 'print-border', type: 'fill', source: 'mask', layout: { visibility: printBorder ? 'visible' : 'none' },
        paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.82 } },   // nearly blank: a ghost of the land beyond
      { id: 'page-edge', type: 'line', source: 'mask', paint: { 'line-color': c.boundary, 'line-width': 1, 'line-opacity': 0.7 } },
    ] : []),
    // OSM-driven labels (hand-placed labels live in HTML on top)
    { id: 'trail-label', type: 'symbol', source: 'osm', minzoom: minz(14),
      filter: ['all', trailFilter, ['has', 'name'], notHand],
      layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': FONT.italic,
        'text-size': T(10), 'symbol-spacing': 350, 'text-offset': [0, -0.75] },
      paint: { 'text-color': '#7f2a31', 'text-halo-color': 'rgba(251,250,246,0.75)', 'text-halo-width': 1.2 } },
    { id: 'road-label', type: 'symbol', source: 'osm', minzoom: minz(13),
      filter: ['all', hw('primary', 'secondary', 'tertiary', 'residential', 'unclassified'), ['has', 'name'], ['!', carFree], notHand],
      layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': FONT.regular,
        'text-size': T(10.5), 'symbol-spacing': 500, 'text-offset': [0, -0.8] },
      paint: { 'text-color': c.ink, 'text-halo-color': 'rgba(251,250,246,0.6)', 'text-halo-width': 1 } },
    { id: 'battery-label', type: 'symbol', source: 'osm', minzoom: minz(14.5),
      filter: ['all', ['==', ['get', 'historic'], 'fort'], ['has', 'name'], notHand],
      layout: { 'text-field': ['get', 'name'], 'text-font': FONT.regular, 'text-size': T(9.5), 'text-max-width': 6 },
      paint: { 'text-color': c.inkSoft, 'text-halo-color': c.openSpace, 'text-halo-width': 1.2 } },
    { id: 'peak-label', type: 'symbol', source: 'osm', minzoom: minz(12),
      filter: ['all', ['==', ['get', 'natural'], 'peak'], ['has', 'name'], notHand],
      // a small summit triangle, the name on whichever side keeps it off the trails (src/peaks.js)
      layout: { 'text-field': ['get', 'name'], 'text-font': FONT.regular, 'text-size': T(11), 'text-max-width': 5,
        'icon-image': 'peak-tri', 'icon-size': T(0.42),
        'text-anchor': ['coalesce', ['get', '_anchor'], 'left'],
        'text-offset': ['match', ['coalesce', ['get', '_anchor'], 'left'],
          ...Object.entries(PEAK_OFFSETS).flatMap(([a, o]) => [a, ['literal', o]]), ['literal', PEAK_OFFSETS.left]] },
      paint: { 'text-color': c.ink } },
    // towns from OSM (hand labels of the same name win). Paper mode prints them at a fixed size like
    // everything else (a city ~80 px at the design zoom, so still legible across the whole region); web mode
    // keeps them a readable screen size. City > town > village.
    { id: 'town-label', type: 'symbol', source: 'osm',
      filter: ['all', ['==', ['geometry-type'], 'Point'], ['has', 'name'], notHand,
        ['any', ['match', ['coalesce', ['get', 'place'], ''], ['city', 'town', 'village'], true, false],
          ['all', ['==', ['get', 'place'], 'hamlet'], ['>=', ['zoom'], 13.5]]]],
      layout: { 'text-field': ['upcase', ['get', 'name']], 'text-font': FONT.regular, 'text-letter-spacing': 0.18,
        'text-size': paper
          ? ['interpolate', ['exponential', 2], ['zoom'], designZoom - 6, ['/', ['match', ['get', 'place'], 'city', 84, 'town', 60, 44], 64],
            designZoom + 1.5, ['*', ['match', ['get', 'place'], 'city', 84, 'town', 60, 44], 2.828]]   // (MapLibre caps text at 255 px)
          : ['interpolate', ['linear'], ['zoom'], 10, ['match', ['get', 'place'], 'city', 12, 'town', 11, 9.5],
            14, ['match', ['get', 'place'], 'city', 16, 'town', 14, 12]],
        'text-max-width': 8, 'text-padding': 6, 'text-allow-overlap': paper, 'text-ignore-placement': paper,
        'symbol-sort-key': ['match', ['get', 'place'], 'city', 0, 'town', 1, 2] },
      paint: { 'text-color': paper ? c.ink : c.townLabel, 'text-opacity': paper ? 0.78 : 1,
        'text-halo-color': c.paper, 'text-halo-width': paper ? 1.2 : 1.6 } },
    // parking only once you're close: zoomed out, hundreds of lots speckle the towns
    { id: 'parking', type: 'symbol', source: 'osm', minzoom: 13,
      filter: ['all', ['==', ['get', 'amenity'], 'parking'], ['!=', ['get', 'access'], 'private'],
        ['!', ['match', ['coalesce', ['get', 'parking'], ''], ['street_side', 'lane', 'garage', 'carports'], true, false]]],
      layout: { 'icon-image': 'parking', 'icon-size': paper ? T(0.5) : ['interpolate', ['linear'], ['zoom'], 13, 0.4, 16, 0.6],
        'icon-allow-overlap': false, 'icon-padding': 24, 'symbol-sort-key': ['-', 0, ['to-number', ['get', 'capacity'], 0]] } },
  ];

  if (!parking) layers.splice(layers.findIndex(l => l.id === 'parking'), 1);
  if (preset === 'nps') npsLayers(layers, { c, W, T, minz, hw, carFree, trailFilter, informal, notHand });
  if (preset === 'veg') vegLayers(layers, { c, W, minz, hw, carFree, trailFilter, informal });
  applyShade(layers, shade);
  for (const l of layers) if (l.id.startsWith('contour')) l.layout = { ...(l.layout || {}), visibility: contours ? 'visible' : 'none' };
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      osm: { type: 'geojson', data: osm, maxzoom: 18, tolerance: 0.25 },
      ...(ripples?.features?.length ? { ripples: { type: 'geojson', data: ripples, tolerance: 0.4 } } : {}),
      ...(access ? { access: { type: 'geojson', data: access, maxzoom: 18, tolerance: 0.25 } } : {}),
      mask: { type: 'geojson', data: mask },
      ofm: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
      dem: { type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        encoding: 'terrarium', tileSize: DEM_TILE[terrainDetail] || 256, maxzoom: DEM_MAXZOOM[terrainDetail] || 15 },
      contours: { type: 'vector', tiles: [contourTiles], maxzoom: 15 },
      ...(veg ? Object.fromEntries(veg.tiles.map(t => [`veg-${t.row}-${t.col}`,
        { type: 'image', url: `${veg.base}/${veg.palette}-${t.row}-${t.col}.webp`, coordinates: t.coordinates }])) : {}),
      ...(relief ? { relief: { type: 'canvas', canvas: relief.canvas, coordinates: relief.coordinates, animate: false } } : {}),
    },
    layers,
  };
}

// World polygon with the place's own boundaries cut out of it.
export function outsideMask(boundaryFeatures) {
  const parts = boundaryFeatures.flatMap(({ geometry: g }) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates));
  if (!parts.length) return { type: 'FeatureCollection', features: [] };   // no park chosen: nothing greyed out
  const world = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {},
    // every outer ring becomes a hole in the world; holes inside a park (towns) stay grey
    geometry: { type: 'MultiPolygon', coordinates: [[world, ...parts.map(p => p[0])], ...parts.flatMap(p => p.slice(1).map(h => [h]))] } }] };
}

// National Park preset: same data, NPS brochure conventions. Rewrites the ECTA layer list in place.
function npsLayers(layers, { c, W, T, minz, hw, carFree, trailFilter, informal, notHand }) {
  const at = (id) => layers.findIndex(l => l.id === id);
  const replace = (id, ...nl) => { const i = at(id); if (i >= 0) layers.splice(i, 1, ...nl); };
  const set = (id, fn) => { const l = layers[at(id)]; if (l) fn(l); };

  // strong grey relief, the main texture of an NPS map
  set('hillshade', l => Object.assign(l.paint, { 'hillshade-exaggeration': 0.42, 'hillshade-shadow-color': '#59615c',
    'hillshade-highlight-color': 'rgba(255,255,255,0.55)', 'hillshade-accent-color': '#7c837f' }));
  set('boundary', l => Object.assign(l.paint, { 'line-color': c.boundary, 'line-width': W(0.8), 'line-dasharray': [1, 0] }));

  // trails: black, the dash says who may use it
  const yes = (k) => ['match', ['coalesce', ['get', k], ''], ['yes', 'designated', 'permissive'], true, false];
  const bikes = ['any', yes('bicycle'), ['all', hw('track'), ['!=', ['get', 'bicycle'], 'no']], carFree];
  const horses = ['any', yes('horse'), hw('bridleway')];
  const base = ['all', trailFilter, ['!', informal]];
  const trail = (id, filter, dash) => ({ id, type: 'line', source: 'osm', minzoom: minz(11), filter: ['all', base, filter],
    layout: { 'line-join': 'round', 'line-cap': dash ? 'butt' : 'round' },
    paint: { 'line-color': c.trail, 'line-width': W(1.7), ...(dash ? { 'line-dasharray': dash } : {}) } });
  replace('trail',
    trail('trail', ['all', bikes, horses], null),                       // hiking, horses, bikes
    trail('trail-horse', ['all', horses, ['!', bikes]], [4, 1.5, 1, 1.5]),  // hiking and horses
    trail('trail-bike', ['all', bikes, ['!', horses]], [3, 2]),          // hiking and bikes
    trail('trail-foot', ['all', ['!', bikes], ['!', horses]], [0.6, 1.4]));  // hiking only
  set('trail-informal', l => Object.assign(l.paint, { 'line-color': '#8a8a8a', 'line-width': W(0.9), 'line-dasharray': [0.6, 1.6] }));

  // roads: white with a dark edge; highways dark red
  const road = (id, filter, w) => [
    { id: `${id}-casing`, type: 'line', source: 'osm', filter, layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': c.road, 'line-width': W(w + 1.1) } },
    { id, type: 'line', source: 'osm', filter, layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': c.roadFill, 'line-width': W(w) } }];
  replace('road-street', ...road('road-street', ['all', hw('residential', 'unclassified', 'living_street', 'tertiary'), ['!', carFree]], 1.1));
  replace('road-main', ...road('road-main', hw('primary', 'secondary', 'primary_link', 'secondary_link'), 1.6));
  set('road-highway-casing', l => Object.assign(l.paint, { 'line-color': c.road, 'line-width': W(3.2) }));
  set('road-highway', l => Object.assign(l.paint, { 'line-color': c.highway, 'line-width': W(2.2) }));

  // labels: plain sans, black; peaks get an open triangle and their height in feet
  set('trail-label', l => { l.layout['text-font'] = ['Noto Sans Regular']; Object.assign(l.paint, { 'text-color': c.ink, 'text-halo-color': 'rgba(236,236,235,0.8)' }); });
  set('peak-label', l => {
    const feet = ['concat', ['to-string', ['round', ['*', ['to-number', ['get', 'ele'], 0], 3.28084]]], '\u2032'];
    Object.assign(l.layout, { 'icon-image': 'peak-tri', 'icon-size': T(0.5), 'text-anchor': 'top', 'text-offset': [0, 0.6],
      'text-field': ['case', ['has', 'ele'],
        ['format', ['get', 'name'], {}, '\n', {}, feet, { 'font-scale': 0.85, 'text-color': c.peak }],
        ['get', 'name']] });
    l.paint = { 'text-color': c.ink, 'text-halo-color': 'rgba(236,236,235,0.7)', 'text-halo-width': 1 };
  });
  set('battery-label', l => { l.paint['text-halo-color'] = 'rgba(236,236,235,0.7)'; });
  set('contour-label', l => { l.paint['text-halo-color'] = c.openSpace; });
}

// Vegetation preset: the painted land cover carries the map; trails are dark ink on a cream
// casing (red fights the greens), roads are pale with a dark edge, no contours by default.
function vegLayers(layers, { c, W, minz, hw, carFree, trailFilter, informal }) {
  const at = (id) => layers.findIndex(l => l.id === id);
  const set = (id, fn) => { const l = layers[at(id)]; if (l) fn(l); };
  const halo = at('trail-halo'); if (halo >= 0) layers.splice(halo, 1);
  // shadows only: white highlights wash the colour out (same lesson as the Blender relief)
  set('hillshade', l => Object.assign(l.paint, { 'hillshade-exaggeration': 0.45, 'hillshade-shadow-color': '#33402f',
    'hillshade-highlight-color': 'rgba(255,255,255,0)', 'hillshade-accent-color': '#4a5546' }));
  const casing = { id: 'trail-casing', type: 'line', source: 'osm', minzoom: minz(11), filter: trailFilter,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': c.trailCasing, 'line-opacity': 0.85, 'line-width': W(3.4) } };
  layers.splice(at('trail'), 0, casing);
  set('trail', l => Object.assign(l.paint, { 'line-color': c.trail, 'line-width': W(1.5) }));
  set('trail-informal', l => Object.assign(l.paint, { 'line-color': c.trail, 'line-width': W(1.1), 'line-dasharray': [2, 1.6] }));
  for (const [id, w] of [['road-street', 1.2], ['road-main', 1.7]]) {
    const i = at(id); if (i < 0) continue;
    const l = layers[i];
    layers.splice(i, 0, { ...l, id: `${id}-casing`, paint: { 'line-color': c.road, 'line-width': W(w + 1.2) } });
    l.paint = { 'line-color': c.roadFill, 'line-width': W(w) };
  }
  set('trail-label', l => Object.assign(l.paint, { 'text-color': c.trail, 'text-halo-color': 'rgba(251,246,234,0.9)', 'text-halo-width': 1.4 }));
  set('peak-label', l => { l.paint = { 'text-color': '#1f1f1f', 'text-halo-color': 'rgba(251,246,234,0.85)', 'text-halo-width': 1.4 }; });
}

// ---- advanced hillshade ("shade"): presets + custom values, applied on top of the map style.
// preset 'style' = whatever the map style does. Everything here is a plain paint property, so the
// editor can also set it live without rebuilding the style.
export const SHADE_PRESETS = {
  style: null,
  google: {   // reverse-engineered from Google Maps' terrain layer: strong teal shading, mint land, faint contours
    method: 'combined', exaggeration: 0.85, direction: 315, altitude: 38,
    shadow: '#1e4436', highlight: '#e6fff1', highlightOpacity: 0.75, accent: '#2f5c4b',
    land: '#bfe5cf', contour: '#4f8a70', contourOpacity: 0.45,
  },
  dramatic: {
    method: 'standard', exaggeration: 1, direction: 300, altitude: 25,
    shadow: '#2a2a2a', highlight: '#ffffff', highlightOpacity: 0.6, accent: '#3a3a3a',
    land: null, contour: null, contourOpacity: null,
  },
  soft: {
    method: 'igor', exaggeration: 0.6, direction: 315, altitude: 45,
    shadow: '#55605a', highlight: '#ffffff', highlightOpacity: 0.4, accent: '#6b746f',
    land: null, contour: null, contourOpacity: null,
  },
};
const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
export function shadePaint(s) {
  return {
    'hillshade-method': s.method, 'hillshade-exaggeration': +s.exaggeration,
    'hillshade-illumination-direction': +s.direction, 'hillshade-illumination-altitude': +s.altitude,
    'hillshade-shadow-color': s.shadow, 'hillshade-accent-color': s.accent,
    'hillshade-highlight-color': rgba(s.highlight, s.highlightOpacity ?? 1),
  };
}
function applyShade(layers, shade) {
  if (!shade || shade.preset === 'style') return;
  const l = layers.find(x => x.id === 'hillshade');
  if (l) l.paint = { ...l.paint, ...shadePaint(shade) };
  if (shade.land) for (const x of layers) if (x.id === 'open-space') x.paint['fill-color'] = shade.land;
  if (shade.contour) for (const x of layers) if (x.id === 'contour' || x.id === 'contour-index')
    Object.assign(x.paint, { 'line-color': shade.contour, 'line-opacity': shade.contourOpacity ?? 0.5 });
}
