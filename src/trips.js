// Saved paddling routes (places/<place>/trips.json) and the click-to-plan route builder.
// A stop is "aton:<NOAA name>", "osm:<OSM name>", or [lon, lat]. Legs are routed
// around land by Router; distances are along the routed path.
import { NM, metres } from './router.js';

const KNOTS = 3; // planning speed for the time estimate

export function resolver(osm, aton) {
  const centroid = (g) => {
    const flat = (c) => (typeof c[0] === 'number' ? [c] : c.flatMap(flat));
    const pts = flat(g.coordinates);
    return [0, 1].map(k => pts.reduce((a, p) => a + p[k], 0) / pts.length);
  };
  return (stop) => {
    if (Array.isArray(stop)) return { at: stop, name: null };
    const [kind, ...rest] = stop.split(':'), name = rest.join(':');
    const pool = kind === 'aton' ? aton.features : osm.features;
    const f = pool.find(f => (f.properties.name === name));
    if (!f) { console.warn('unknown stop', stop); return null; }
    const label = kind === 'aton' ? (f.properties.label || name) : name;
    return { at: f.geometry.type === 'Point' ? f.geometry.coordinates : centroid(f.geometry), name: label };
  };
}

// route a list of resolved stops → GeoJSON with legs (labelled) and stop points, plus totals
export const UNITS = { nm: { per: 1, label: 'nm' }, mi: { per: 1.15078, label: 'mi' } };
export const fmtDist = (nm, unit = 'nm', digits = 1) => `${(nm * UNITS[unit].per).toFixed(digits)} ${UNITS[unit].label}`;

export function buildTrip(router, stops, unit = 'nm') {
  const features = [], legs = [];
  router?.resetVisited();
  stops.forEach((s, i) => features.push({ type: 'Feature', properties: { kind: 'stop', i, name: s.name || '' },
    geometry: { type: 'Point', coordinates: s.at } }));
  for (let i = 1; i < stops.length; i++) {
    const coords = router ? router.leg(stops[i - 1].at, stops[i].at) : [stops[i - 1].at, stops[i].at];
    const nm = metres(coords) / NM;
    legs.push({ from: stops[i - 1].name, to: stops[i].name, nm });
    features.push({ type: 'Feature', properties: { kind: 'leg', nm },
      geometry: { type: 'LineString', coordinates: coords } });
    // label point halfway along the routed leg (one label per leg, whatever the tiling)
    let half = metres(coords) / 2, mid = coords[0];
    for (let k = 1; k < coords.length; k++) {
      const seg = metres([coords[k - 1], coords[k]]);
      if (seg >= half) { const t = half / seg; mid = [0, 1].map(j => coords[k - 1][j] + (coords[k][j] - coords[k - 1][j]) * t); break; }
      half -= seg;
    }
    features.push({ type: 'Feature', properties: { kind: 'mid', label: fmtDist(nm, unit) }, geometry: { type: 'Point', coordinates: mid } });
  }
  const total = legs.reduce((a, l) => a + l.nm, 0);
  return { geojson: { type: 'FeatureCollection', features }, legs, total };
}

export function summary({ legs, total }) {
  const h = total / KNOTS, mins = Math.round(h * 60);
  const time = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
  return {
    total: `${total.toFixed(1)} nm · ${(total * 1.15078).toFixed(1)} mi · ~${time} at ${KNOTS} kn`,
    legs: legs.map(l => `${l.from || 'waypoint'} → ${l.to || 'waypoint'}: ${l.nm.toFixed(2)} nm`),
  };
}
