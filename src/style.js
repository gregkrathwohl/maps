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

export function buildStyle({ c, osm, mask, contourTiles, mode = 'web', designZoom = 13.5, hillshade = false, relief = null, veg = null, contours = true, handNames = [] }) {
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
      paint: { 'fill-color': c.paper } },

    // painterly vegetation (scripts/vegetation.py): image tiles clipped to parks, under the relief
    ...(veg ? veg.tiles.map(t => ({ id: `veg-${t.row}-${t.col}`, type: 'raster', source: `veg-${t.row}-${t.col}`,
      paint: { 'raster-resampling': 'linear', 'raster-fade-duration': 0, 'raster-opacity': vegOpacity(veg) } })) : []),

    ...(veg ? [{ id: 'developed-veg', type: 'fill', source: 'osm', filter: ['any',
        ['match', ['coalesce', ['get', 'landuse'], ''], ['residential', 'commercial', 'industrial', 'retail', 'military', 'construction'], true, false],
        ['==', ['get', 'amenity'], 'parking']],
      paint: { 'fill-color': c.outside, 'fill-opacity': c.outsideOpacity } }] : []),

    // Blender relief (pre-rendered, transparent shadows + highlights) or the browser's own
    ...(hillshade && relief ? [{ id: 'relief', type: 'raster', source: 'relief',
      paint: { 'raster-opacity': relief.opacity ?? 0.9, 'raster-resampling': 'linear', 'raster-fade-duration': 0 } }] : []),
    ...(hillshade && !relief ? [{ id: 'hillshade', type: 'hillshade', source: 'dem',
      paint: { 'hillshade-method': 'multidirectional', 'hillshade-exaggeration': 0.35,
        'hillshade-shadow-color': '#5d6b5a', 'hillshade-highlight-color': '#ffffff', 'hillshade-accent-color': '#8a8a7a' } }] : []),

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
      filter: ['all', hw('residential', 'unclassified', 'living_street', 'tertiary'), ['!', carFree]],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.street, 'line-width': W(1.2) } },
    { id: 'road-main', type: 'line', source: 'osm',
      filter: hw('primary', 'secondary', 'primary_link', 'secondary_link'),
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.road, 'line-width': W(1.8) } },
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
    { id: 'coastline', type: 'line', source: 'osm',
      filter: ['all', ['==', ['get', 'natural'], 'coastline'], ['==', ['geometry-type'], 'LineString']],
      paint: { 'line-color': c.waterLine, 'line-width': W(0.7) } },
    // OSM-driven labels (hand-placed labels live in HTML on top)
    { id: 'trail-label', type: 'symbol', source: 'osm', minzoom: minz(14),
      filter: ['all', trailFilter, ['has', 'name']],
      layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': FONT.italic,
        'text-size': T(10), 'symbol-spacing': 350, 'text-offset': [0, -0.75] },
      paint: { 'text-color': '#7f2a31', 'text-halo-color': 'rgba(251,250,246,0.75)', 'text-halo-width': 1.2 } },
    { id: 'road-label', type: 'symbol', source: 'osm', minzoom: minz(13),
      filter: ['all', hw('primary', 'secondary', 'tertiary', 'residential', 'unclassified'), ['has', 'name'], ['!', carFree]],
      layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': FONT.regular,
        'text-size': T(10.5), 'symbol-spacing': 500, 'text-offset': [0, -0.8] },
      paint: { 'text-color': c.ink, 'text-halo-color': 'rgba(251,250,246,0.6)', 'text-halo-width': 1 } },
    { id: 'battery-label', type: 'symbol', source: 'osm', minzoom: minz(14.5),
      filter: ['all', ['==', ['get', 'historic'], 'fort'], ['has', 'name'], notHand],
      layout: { 'text-field': ['get', 'name'], 'text-font': FONT.regular, 'text-size': T(9.5), 'text-max-width': 6 },
      paint: { 'text-color': c.inkSoft, 'text-halo-color': c.openSpace, 'text-halo-width': 1.2 } },
    { id: 'peak-label', type: 'symbol', source: 'osm', minzoom: minz(12),
      filter: ['all', ['==', ['get', 'natural'], 'peak'], ['has', 'name'], notHand],
      layout: { 'text-field': ['get', 'name'], 'text-font': FONT.regular, 'text-size': T(11), 'text-max-width': 5 },
      paint: { 'text-color': c.ink } },
    { id: 'parking', type: 'symbol', source: 'osm', minzoom: minz(13),
      filter: ['all', ['==', ['get', 'amenity'], 'parking'], ['!=', ['get', 'access'], 'private'],
        ['!', ['match', ['coalesce', ['get', 'parking'], ''], ['street_side', 'lane', 'garage', 'carports'], true, false]]],
      layout: { 'icon-image': 'parking', 'icon-size': paper ? T(0.5) : ['interpolate', ['linear'], ['zoom'], 13, 0.4, 16, 0.6],
        'icon-allow-overlap': false, 'icon-padding': 24, 'symbol-sort-key': ['-', 0, ['to-number', ['get', 'capacity'], 0]] } },
  ];

  if (!contours) for (let i = layers.length - 1; i >= 0; i--) if (layers[i].id.startsWith('contour')) layers.splice(i, 1);
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      osm: { type: 'geojson', data: osm, maxzoom: 18, tolerance: 0.25 },
      mask: { type: 'geojson', data: mask },
      ofm: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
      dem: { type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        encoding: 'terrarium', tileSize: 256, maxzoom: 15 },
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
