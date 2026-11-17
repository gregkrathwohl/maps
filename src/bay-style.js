// Water-first style: same family as the trail guides, but the land steps back
// and the bay carries the map: depth tint, isobaths, waterlines along the coast,
// buoys and beacons, and launch/landing spots.

const FONT = { regular: ['Noto Sans Regular'], italic: ['Noto Sans Italic'], bold: ['Noto Sans Bold'] };

export const bayPalette = {
  land: '#f7f4ec',
  park: '#dde3d4',
  water: '#cde4ec',
  coast: '#4d86ad',
  waterline: '#5f97bd',
  isobath: '#7fb0cf',
  current: '#2f6f9f',
  route: '#b8414a',
  road: '#b9b4a8',
  roadMajor: '#8f8a80',
  trail: '#c98a8e',
  ink: '#1f1f1f',
  inkSoft: '#5a5a5a',
  waterInk: '#2f6a9a',
  outside: '#ece9e1',
};

export function buildBayStyle({ c = bayPalette, osm, mask, currents, routes, aton, coastLines, ripples, trips, waterMode = 'ripples', waterShade = 0.1, contourTiles, mode = 'web', designZoom = 13.6, hillshade = false, handNames = [] }) {
  const paper = mode === 'paper';
  const W = (base, k = null) => {
    const v = (x) => (k ? ['*', k, x] : x);
    return paper
      ? ['interpolate', ['exponential', 2], ['zoom'], designZoom - 6, v(base / 64), designZoom + 6, v(base * 64)]
      : ['interpolate', ['linear'], ['zoom'], 10, v(base * 0.5), 13, v(base * 0.85), 15, v(base * 1.3), 18, v(base * 2.2)];
  };
  const T = (base) => paper
    ? ['interpolate', ['exponential', 2], ['zoom'], designZoom - 6, base / 64, designZoom + 6, base * 64]
    : ['interpolate', ['linear'], ['zoom'], 11, base * 0.8, 14, base, 17, base * 1.3];
  // line offsets in px scale with paper too
  const minz = (z) => (paper ? 0 : z);
  const hw = (...v) => ['match', ['get', 'highway'], v, true, false];
  const notHand = ['!', ['in', ['coalesce', ['get', 'name'], ''], ['literal', handNames]]];
  const coast = ['==', ['get', 'natural'], 'coastline'];
  const seamark = (t) => ['==', ['get', 'seamark:type'], t];
  const buoyColour = ['coalesce',
    ['get', 'seamark:buoy_lateral:colour'], ['get', 'seamark:beacon_lateral:colour'],
    ['get', 'seamark:buoy_special_purpose:colour'], ['get', 'seamark:buoy_safe_water:colour'],
    ['get', 'seamark:light:colour'], ''];

  const layers = [
    { id: 'land', type: 'background', paint: { 'background-color': c.land } },
    { id: 'park', type: 'fill', source: 'osm',
      filter: ['any', ['==', ['get', 'boundary'], 'protected_area'], ['==', ['get', 'boundary'], 'national_park'],
        ['match', ['coalesce', ['get', 'leisure'], ''], ['nature_reserve', 'park'], true, false]],
      paint: { 'fill-color': c.park } },
    { id: 'developed', type: 'fill', source: 'osm',
      filter: ['match', ['coalesce', ['get', 'landuse'], ''], ['residential', 'commercial', 'industrial', 'retail'], true, false],
      paint: { 'fill-color': c.land } },
    ...(hillshade ? [{ id: 'hillshade', type: 'hillshade', source: 'dem',
      paint: { 'hillshade-method': 'multidirectional', 'hillshade-exaggeration': 0.3,
        'hillshade-shadow-color': '#6b6a5e', 'hillshade-highlight-color': '#ffffff', 'hillshade-accent-color': '#8a8a7a' } }] : []),
    { id: 'land-contour', type: 'line', source: 'contours', 'source-layer': 'contours', minzoom: minz(12),
      filter: ['>', ['get', 'ele'], 0],
      paint: { 'line-color': '#d9c7aa', 'line-width': W(0.4), 'line-opacity': 0.6 } },

    // ---- water: base, depth tint, isobaths
    { id: 'water', type: 'fill', source: 'ofm', 'source-layer': 'water', paint: { 'fill-color': c.water } },
    { id: 'depth', type: 'color-relief', source: 'dem',
      paint: { 'color-relief-opacity': 0.9, 'color-relief-color': ['interpolate', ['linear'], ['elevation'],
        -80, '#5f9cc4', -40, '#7fb1d3', -20, '#9cc5df', -8, '#b3d3e5', -2, '#c6dfea', -0.3, 'rgba(205,228,236,0)', 0, 'rgba(0,0,0,0)'] } },
    // a tunable darkening of all water (the "Water tone" slider), under the texture and streaks
    { id: 'water-shade', type: 'fill', source: 'ofm', 'source-layer': 'water',
      paint: { 'fill-color': '#4f95c8', 'fill-opacity': waterShade } }, // a clear blue, so turning it up reads bluer, not greyer
    { id: 'marsh', type: 'fill', source: 'osm', minzoom: minz(12), filter: ['==', ['get', 'natural'], 'wetland'],
      paint: { 'fill-pattern': 'marsh' } },
    { id: 'beach', type: 'fill', source: 'osm', minzoom: minz(12),
      filter: ['match', ['coalesce', ['get', 'natural'], ''], ['beach', 'sand'], true, false], paint: { 'fill-pattern': 'stipple' } },

    // ---- water texture: depth contours and/or ripples (waterMode: 'ripples' | 'depth' | 'both')
    ...(waterMode !== 'ripples' ? [
    { id: 'isobath', type: 'line', source: 'contours', 'source-layer': 'contours',
      filter: ['<', ['get', 'ele'], 0],
      paint: { 'line-color': c.isobath, 'line-width': W(0.4, ['case', ['>', ['get', 'level'], 0], 1.75, 1]), 'line-opacity': 0.55 } },
      { id: 'isobath-label', type: 'symbol', source: 'contours', 'source-layer': 'contours', minzoom: minz(14),
      filter: ['all', ['<', ['get', 'ele'], 0], ['>', ['get', 'level'], 0]],
      layout: { 'symbol-placement': 'line', 'text-field': ['concat', ['to-string', ['abs', ['get', 'ele']]], ' ft'],
        'text-font': FONT.italic, 'text-size': T(8.5), 'symbol-spacing': 450 },
      paint: { 'text-color': c.isobath, 'text-halo-color': c.water, 'text-halo-width': 1.2 } },
    ] : []),
    // ripples are true buffers around the land (scripts/water.mjs), so they live in metres:
    // they scale with Paper mode and merge in narrow inlets instead of crossing
    ...(waterMode !== 'depth' ? [{
      id: 'ripple', type: 'line', source: 'ripples', minzoom: minz(11.5),
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': c.waterline, 'line-width': W(0.6),
        'line-opacity': ['match', ['get', 'step'], 0, 0.55, 1, 0.38, 2, 0.24, 0.13] } }] : []),
    { id: 'coast', type: 'line', source: 'coast',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': c.coast, 'line-width': W(1.1) } },

    // ---- land detail, kept quiet
    { id: 'road', type: 'line', source: 'osm', minzoom: minz(12),
      filter: hw('residential', 'unclassified', 'tertiary', 'living_street', 'service'),
      paint: { 'line-color': c.road, 'line-width': W(0.55), 'line-opacity': 0.7 } },
    { id: 'road-major', type: 'line', source: 'osm',
      filter: hw('primary', 'secondary', 'motorway', 'trunk', 'primary_link', 'secondary_link', 'motorway_link'),
      paint: { 'line-color': c.roadMajor, 'line-width': W(1.3) } },
    // paths stay quiet on a water map: only real trails (not city footways), only zoomed in
    { id: 'trail', type: 'line', source: 'osm', minzoom: minz(14),
      filter: ['all', hw('path', 'track', 'bridleway'), ['!', ['has', 'footway']]],
      paint: { 'line-color': c.trail, 'line-width': W(0.7), 'line-opacity': 0.7 } },
    { id: 'pier', type: 'line', source: 'osm', minzoom: minz(13),
      filter: ['match', ['coalesce', ['get', 'man_made'], ''], ['pier', 'breakwater', 'groyne'], true, false],
      paint: { 'line-color': '#8a8273', 'line-width': W(1.4) } },
    { id: 'outside', type: 'fill', source: 'mask', paint: { 'fill-color': c.outside, 'fill-opacity': 0 } },

    // ---- the selected route (saved trip or the planner): trail red, dashed, with a white edge
    { id: 'trip-casing', type: 'line', source: 'trips', filter: ['==', ['get', 'kind'], 'leg'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': 'rgba(255,255,255,0.75)', 'line-width': W(4) } },
    { id: 'trip', type: 'line', source: 'trips', filter: ['==', ['get', 'kind'], 'leg'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': c.route, 'line-width': W(2), 'line-dasharray': [2.5, 1.6] } },
    { id: 'trip-stop', type: 'circle', source: 'trips', filter: ['==', ['get', 'kind'], 'stop'],
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 3, 16, 5], 'circle-color': '#fff',
        'circle-stroke-color': c.route, 'circle-stroke-width': 1.6 } },
    { id: 'trip-distance', type: 'symbol', source: 'trips', filter: ['==', ['get', 'kind'], 'mid'],
      layout: { 'text-field': ['get', 'label'], 'text-font': FONT.bold,
        'text-size': T(11), 'text-allow-overlap': true },
      paint: { 'text-color': c.route, 'text-halo-color': 'rgba(255,255,255,0.92)', 'text-halo-width': 1.8 } },

    // ---- aids to navigation (NOAA ENC): buoys as discs, beacons as small squares, chart-style labels
    // markers deep in Richardson Bay wait until you zoom in
    { id: 'beacon', type: 'symbol', source: 'aton', minzoom: minz(12),
      filter: ['all', ['!', ['get', 'buoy']], ['any', ['!', ['get', 'inner']], ['>=', ['zoom'], 14]]],
      layout: { 'text-field': '■', 'text-font': FONT.regular, 'text-size': ['interpolate', ['linear'], ['zoom'], 12, 7, 15, 11],
        'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': ['match', ['get', 'colour'], 'red', '#c8323a', 'green', '#2f8a4a', 'yellow', '#e2b52b', '#555'],
        'text-halo-color': '#1f1f1f', 'text-halo-width': 0.6 } },
    { id: 'buoy', type: 'circle', source: 'aton', minzoom: minz(11),
      filter: ['all', ['get', 'buoy'], ['any', ['!', ['get', 'inner']], ['>=', ['zoom'], 14]]],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2.2, 15, 4.5],
        'circle-color': ['match', ['get', 'colour'], 'red', '#c8323a', 'green', '#2f8a4a', 'yellow', '#e2b52b', 'white', '#ffffff', '#888'],
        'circle-stroke-color': '#1f1f1f', 'circle-stroke-width': 0.8 } },
    { id: 'aton-label', type: 'symbol', source: 'aton', minzoom: minz(12.5),
      filter: ['all', ['!=', ['get', 'label'], ''], ['any', ['!', ['get', 'inner']], ['>=', ['zoom'], 15.5]]],
      layout: { 'text-field': ['get', 'label'], 'text-font': FONT.italic, 'text-size': T(9),
        'text-anchor': 'left', 'text-offset': [0.7, 0], 'text-max-width': 8 },
      paint: { 'text-color': ['match', ['get', 'colour'], 'red', '#a3262d', 'green', '#22693a', c.inkSoft],
        'text-halo-color': 'rgba(255,255,255,0.8)', 'text-halo-width': 1.2 } },

    // ---- launches: the reason to open this map
    { id: 'launch', type: 'symbol', source: 'routes', filter: ['match', ['coalesce', ['get', 'kind'], ''], ['launch', 'landing'], true, false],
      layout: { 'icon-image': 'kayak', 'icon-size': paper ? T(0.55) : ['interpolate', ['linear'], ['zoom'], 12, 0.45, 16, 0.7],
        'icon-allow-overlap': true, 'text-field': ['get', 'name'], 'text-font': FONT.bold, 'text-size': T(10.5),
        'text-anchor': 'left', 'text-offset': [1.3, 0], 'text-max-width': 9, 'text-optional': true },
      paint: { 'text-color': '#245a40', 'text-halo-color': 'rgba(255,255,255,0.85)', 'text-halo-width': 1.4 } },

    { id: 'peak-label', type: 'symbol', source: 'osm', minzoom: minz(13),
      filter: ['all', ['==', ['get', 'natural'], 'peak'], ['has', 'name'], notHand],
      layout: { 'text-field': ['get', 'name'], 'text-font': FONT.regular, 'text-size': T(10) },
      paint: { 'text-color': c.inkSoft } },
  ];

  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      osm: { type: 'geojson', data: osm, maxzoom: 18, tolerance: 0.25 },
      mask: { type: 'geojson', data: mask },
      currents: { type: 'geojson', data: currents, lineMetrics: true },
      routes: { type: 'geojson', data: routes },
      aton: { type: 'geojson', data: aton },
      trips: { type: 'geojson', data: trips || { type: 'FeatureCollection', features: [] } },
      ripples: { type: 'geojson', data: ripples || { type: 'FeatureCollection', features: [] } },
      // joined + smoothed coastline (scripts/coast.mjs); falls back to raw OSM coastline
      coast: { type: 'geojson', data: coastLines?.features?.length ? coastLines
        : { type: 'FeatureCollection', features: osm.features.filter(f => f.properties.natural === 'coastline') } },
      ofm: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
      dem: { type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        encoding: 'terrarium', tileSize: 256, maxzoom: 15 },
      contours: { type: 'vector', tiles: [contourTiles], maxzoom: 15 },
    },
    layers,
  };
}
