"""Which stretches of trail cross land the public can't (or shouldn't) use.

Reads places/<place>/data/osm.geojson and cpad.geojson (scripts/fetch-cpad.mjs) and writes
places/<place>/data/trail-access.geojson: just the trail pieces that run through
  closed   - CPAD "No Public Access" land (e.g. water-district or utility land)
  private  - land that is neither public (OSM parks/protected areas, CPAD open or restricted) nor town:
             a ranch, a private estate. Only paths, tracks and bridleways count here, so town footpaths
             and public stairways (sidewalks, Mill Valley's steps) on ordinary private lots are left alone.
The map draws these pieces faintly over the trail, so the trail itself is unchanged and the cue stays quiet.

usage: .venv/bin/python scripts/trail-access.py <place>
"""
import json, math, sys
from shapely.geometry import shape, mapping
from shapely.ops import unary_union
from shapely.validation import make_valid

place = sys.argv[1]
base = f'places/{place}/data'
cfg = json.load(open(f'places/{place}/place.json'))
# trails that are public even where they cross private land (easements): tagged open in OSM, or listed by name
# in place.json "publicTrails"
OPEN = {'yes', 'designated', 'permissive'}
public_names = set(cfg.get('publicTrails', []))
def is_public_way(p):
    return p.get('foot') in OPEN or p.get('access') in OPEN or p.get('name') in public_names
osm = json.load(open(f'{base}/osm.geojson'))['features']
cpad = json.load(open(f'{base}/cpad.geojson'))['features']

def geom(f):
    try:
        g = shape(f['geometry'])
        return g if g.is_valid else make_valid(g)
    except Exception:
        return None

def polys(fs):
    gs = [g for g in map(geom, fs) if g is not None and g.geom_type in ('Polygon', 'MultiPolygon', 'GeometryCollection')]
    return unary_union(gs).buffer(0) if gs else None

P = lambda f: f['properties']
public = polys([f for f in osm if P(f).get('boundary') in ('protected_area', 'national_park')
                or P(f).get('leisure') in ('nature_reserve', 'park')]
               + [f for f in cpad if P(f).get('access') in ('Open Access', 'Restricted Access')])
closed = polys([f for f in cpad if P(f).get('access') == 'No Public Access'])
town = polys([f for f in osm if P(f).get('landuse') in ('residential', 'commercial', 'retail', 'industrial')
              or P(f).get('amenity') in ('school',) or P(f).get('place') in ('city', 'town', 'village')
              and f['geometry']['type'] != 'Point'])

TRAIL = {'path', 'track', 'bridleway', 'footway', 'steps', 'cycleway'}
RURAL = {'path', 'track', 'bridleway'}
lat0 = 38.0
def metres(g):  # rough length in metres near lat0
    kx, ky = 111320 * math.cos(math.radians(lat0)), 110540
    total = 0
    for line in getattr(g, 'geoms', [g]):
        c = list(getattr(line, 'coords', []))
        total += sum(math.hypot((x2 - x1) * kx, (y2 - y1) * ky) for (x1, y1), (x2, y2) in zip(c, c[1:]))
    return total

def lines(g):
    if g.is_empty: return []
    if g.geom_type == 'LineString': return [g]
    if g.geom_type == 'MultiLineString': return list(g.geoms)
    if g.geom_type == 'GeometryCollection': return [x for p in g.geoms for x in lines(p)]
    return []

out, stats = [], {'closed': 0, 'private': 0}
for f in osm:
    p = P(f)
    if f['geometry']['type'] != 'LineString' or p.get('highway') not in TRAIL: continue
    if p.get('footway') in ('sidewalk', 'crossing', 'access_aisle'): continue
    g = geom(f)
    if g is None: continue
    pieces = []
    if closed is not None and g.intersects(closed):
        pieces += [('closed', x) for x in lines(g.intersection(closed))]
        g = g.difference(closed)
    if p['highway'] in RURAL and not g.is_empty and not is_public_way(p):
        rest = g
        for land in (public, town):
            if land is not None and rest.intersects(land): rest = rest.difference(land)
        pieces += [('private', x) for x in lines(rest)]
    for kind, x in pieces:
        m = metres(x)
        if m < 40: continue   # slivers where a trail grazes a boundary
        stats[kind] += m
        out.append({'type': 'Feature', 'geometry': mapping(x),
                    'properties': {'access': kind, 'name': p.get('name'), 'highway': p['highway'], '_id': p.get('_id')}})

json.dump({'type': 'FeatureCollection', 'features': out}, open(f'{base}/trail-access.geojson', 'w'))
print(f'{base}/trail-access.geojson', len(out), 'pieces', {k: f'{v / 1609:.0f} mi' for k, v in stats.items()})
