"""Painterly vegetation layer: NAIP aerial photo → a hand-drawn-looking land-cover texture.

  .venv/bin/python scripts/vegetation.py marin-headlands [--res 1.25] [--tile 3000] [--only 1,2]

Procedural, not AI art:
  1. Fetch USGS NAIP (4 bands: R, G, B, near-infrared) in Web Mercator, tile by tile.
  2. Classify each pixel from greenness (NDVI, from the near-infrared band) and roughness
     (scrub is lumpy, grass is smooth): dense scrub/trees, coastal scrub, green meadow,
     grass, dry grass. Smooth the class edges so they're organic, not pixelly.
  3. Draw it: flat colour per class, a lumpy canopy for scrub (a "metaball" height field of
     overlapping bumps, warped by noise and lit from the north-west, so it reads as clumps of
     bushes without any visible circles), a scalloped dark edge, a soft drop shadow, and
     a few grass tufts.
  4. Clip to parks and open space; water and town stay transparent.

Writes places/<id>/data/veg/<palette>-<row>-<col>.webp for each palette (green = spring,
golden = summer/autumn) and data/veg/veg.json with each tile's corners. Everything is local
(blurs, bumps, noise are all computed in global coordinates), so tiles join without seams.
"""
import argparse, io, json, math, urllib.parse, urllib.request
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image, ImageDraw
from scipy import ndimage

URL = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage'
R = 6378137.0
DENSE, SCRUB, GREEN, GRASS, DRY = range(5)

# class colours (DENSE, SCRUB, GREEN, GRASS, DRY): spring from the satellite's own colours,
# golden = the iconic summer hills (grass cures gold, coyote brush and oaks stay dark green)
PALETTES = {
    'green':  [(108, 142, 103), (139, 157, 125), (151, 170, 140), (187, 191, 160), (204, 197, 169)],
    'golden': [(92, 116, 78), (139, 142, 98), (209, 178, 110), (219, 192, 124), (226, 205, 150)],
    # late autumn / early winter (Greg's photo): rosy brown grass, muted olive scrub
    'autumn': [(96, 110, 80), (128, 134, 100), (181, 160, 136), (192, 167, 145), (201, 178, 156)],
}
TUFT = {'green': (0.70, 200), 'golden': (0.72, 190), 'autumn': (0.78, 170)}  # darken factor, alpha


def merc(lon, lat):
    return R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def lonlat(x, y):
    return math.degrees(x / R), math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2)


def fetch_naip(cache, x0, y0, x1, y1, W, H, chunk=1600):
    """the service times out on big requests, so ask for ≤1600 px pieces and stitch them"""
    if cache.exists():
        return np.load(cache)
    out = np.zeros((H, W, 4), np.uint8)
    rx, ry = (x1 - x0) / W, (y1 - y0) / H
    for r0 in range(0, H, chunk):
        for c0 in range(0, W, chunk):
            h, w = min(chunk, H - r0), min(chunk, W - c0)
            q = {'bbox': f'{x0 + c0 * rx},{y1 - (r0 + h) * ry},{x0 + (c0 + w) * rx},{y1 - r0 * ry}',
                 'bboxSR': 3857, 'imageSR': 3857, 'size': f'{w},{h}',
                 'format': 'tiff', 'pixelType': 'U8', 'bandIds': '0,1,2,3', 'f': 'image'}
            req = urllib.request.Request(URL + '?' + urllib.parse.urlencode(q), headers={'User-Agent': 'trail-cartography'})
            for attempt in range(4):
                try:
                    out[r0:r0 + h, c0:c0 + w] = tifffile.imread(io.BytesIO(urllib.request.urlopen(req, timeout=300).read()))
                    break
                except Exception as err:
                    print('  retry', err)
            else:
                raise SystemExit('NAIP fetch failed')
    np.save(cache, out)
    return out


class Noise:
    """smooth value noise in global pixel coordinates (same everywhere, so no tile seams)"""

    def __init__(self, seed, W, H, cell):
        self.cell = cell
        self.g = np.random.default_rng(seed).standard_normal((H // cell + 4, W // cell + 4)).astype(np.float32)

    def __call__(self, gy, gx):
        return ndimage.map_coordinates(self.g, [gy / self.cell + 1, gx / self.cell + 1], order=3, mode='nearest')


def jitter_grid(seed, W, H, spacing):
    rng = np.random.default_rng(seed)
    ys, xs = np.mgrid[0:H:spacing, 0:W:spacing].astype(np.float32)
    xs += rng.uniform(0, spacing, xs.shape); ys += rng.uniform(0, spacing, ys.shape)
    return xs.ravel(), ys.ravel(), rng.random(xs.size).astype(np.float32), rng.random(xs.size).astype(np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('place')
    ap.add_argument('--res', type=float, default=1.25, help='mercator metres per pixel')
    ap.add_argument('--tile', type=int, default=3000)
    ap.add_argument('--only', default='', help='row,col of a single tile (for quick tests)')
    a = ap.parse_args()

    root = Path(__file__).resolve().parent.parent / 'places' / a.place
    cfg = json.loads((root / 'place.json').read_text())
    w, s, e, n = cfg.get('vegetation', {}).get('bbox', cfg['bbox'])
    X0, Y0 = merc(w, s); X1, Y1 = merc(e, n)
    res = max(a.res, max(X1 - X0, Y1 - Y0) / 12500)   # keep big maps to ~16 tiles
    W, H = round((X1 - X0) / res), round((Y1 - Y0) / res)
    m = lambda metres: metres / res          # metres → pixels
    out = root / 'data' / 'veg'; out.mkdir(parents=True, exist_ok=True)
    cache = root / 'data' / 'naip'; cache.mkdir(parents=True, exist_ok=True)
    print(f'{W}×{H} px @ {res:.2f} m, {math.ceil(H / a.tile) * math.ceil(W / a.tile)} tiles', flush=True)

    # global randomness: bush positions, sizes, noise fields
    bush_pts = jitter_grid(11, W, H, m(12))
    scrub_pts = jitter_grid(12, W, H, m(16))
    tuft_pts = jitter_grid(13, W, H, m(57))
    warp1 = (Noise(21, W, H, int(m(8))), Noise(22, W, H, int(m(8))))
    warp2 = (Noise(23, W, H, int(m(20))), Noise(24, W, H, int(m(20))))
    tone = Noise(25, W, H, int(m(140)))
    grain = Noise(26, W, H, max(2, int(m(2.5))))

    # parks / open space, minus developed land (same rule as the ECTA style's sage fill)
    osm = json.loads((root / 'data' / 'osm.geojson').read_text())
    def is_park(p):
        return p.get('boundary') in ('protected_area', 'national_park') or p.get('leisure') in ('nature_reserve', 'park')
    def is_dev(p):
        return p.get('landuse') in ('residential', 'commercial', 'industrial', 'retail', 'military', 'construction') or p.get('amenity') == 'parking'
    polys = [(f, is_park(f['properties'])) for f in osm['features']
             if f['geometry']['type'] in ('Polygon', 'MultiPolygon') and (is_park(f['properties']) or is_dev(f['properties']))]

    clip_all = cfg.get('extent') == 'bbox'
    T, M = a.tile, 64
    rows, cols = math.ceil(H / T), math.ceil(W / T)
    only = tuple(map(int, a.only.split(','))) if a.only else None
    tiles = []
    for ti in range(rows):
        for tj in range(cols):
            ty0, tx0 = ti * T, tj * T
            th, tw = min(T, H - ty0), min(T, W - tx0)
            # corners of the tile itself (for the map)
            cx0, cy1 = X0 + tx0 * res, Y1 - ty0 * res
            cx1, cy0 = cx0 + tw * res, cy1 - th * res
            nw, se = lonlat(cx0, cy1), lonlat(cx1, cy0)
            tiles.append({'row': ti, 'col': tj, 'coordinates': [[nw[0], nw[1]], [se[0], nw[1]], [se[0], se[1]], [nw[0], se[1]]]})
            if only and only != (ti, tj):
                continue
            # the working window: tile + margin, so blurs and bumps match across seams
            gy0, gx0 = ty0 - M, tx0 - M
            hh, ww = th + 2 * M, tw + 2 * M
            wx0, wy1 = X0 + gx0 * res, Y1 - gy0 * res
            naip = fetch_naip(cache / f'{ti}-{tj}.npy', wx0, wy1 - hh * res, wx0 + ww * res, wy1, ww, hh)
            for pal in PALETTES:
                img = render_tile(naip, gy0, gx0, hh, ww, res, m, pal, bush_pts, scrub_pts, tuft_pts,
                                  warp1, warp2, tone, grain, polys, X0, Y1, clip_all)
                img.crop((M, M, M + tw, M + th)).save(out / f'{pal}-{ti}-{tj}.webp', quality=86, method=5)
            print(f'tile {ti * cols + tj + 1}/{rows * cols} done', flush=True)
    (out / 'veg.json').write_text(json.dumps({'res': res, 'palettes': list(PALETTES), 'tiles': tiles}, indent=1))
    cfg['vegetation'] = {**cfg.get('vegetation', {}), 'index': 'data/veg/veg.json'}
    (root / 'place.json').write_text(json.dumps(cfg, indent=2) + '\n')


_cls_cache = {}


def classify(naip, m):
    key = id(naip)
    if key in _cls_cache:
        return _cls_cache[key]
    f = naip.astype(np.float32) / 255
    bl = lambda x, metres: ndimage.gaussian_filter(x, m(metres))
    r, g, b, nir = (bl(f[..., i], 3.75) for i in range(4))
    ndvi = (nir - r) / (nir + r + 1e-6)
    lum = f[..., :3].mean(-1)
    rough = np.sqrt(np.maximum(bl(lum ** 2, 7.5) - bl(lum, 7.5) ** 2, 0))
    water = (nir < 0.2) & (ndvi < 0.12)
    cls = np.full(lum.shape, DRY, np.uint8)
    cls[ndvi > 0.10] = GRASS
    cls[ndvi > 0.19] = GREEN
    cls[(ndvi > 0.16) & (rough > 0.05)] = SCRUB
    cls[(ndvi > 0.29) & (rough > 0.03)] = DENSE
    # organic edges: blur each class mask, keep the strongest
    stack = np.stack([ndimage.gaussian_filter((cls == k).astype(np.float32), m(15)) for k in range(5)])
    cls = stack.argmax(0).astype(np.uint8)
    # soft weights for the ground colour, so tones fade into each other instead of hard splotches
    soft = np.stack([ndimage.gaussian_filter((cls == k).astype(np.float32), m(7)) for k in range(5)], -1)
    water = ndimage.gaussian_filter(water.astype(np.float32), m(4)) > 0.5
    _cls_cache.clear(); _cls_cache[key] = (cls, water, soft)
    return cls, water, soft


def render_tile(naip, gy0, gx0, hh, ww, res, m, pal, bush_pts, scrub_pts, tuft_pts, warp1, warp2, tone, grain, polys, X0, Y1, clip_all=False):
    cls, water, soft = classify(naip, m)
    P = np.array(PALETTES[pal], np.float32)
    gy, gx = np.mgrid[gy0:gy0 + hh, gx0:gx0 + ww].astype(np.float32)

    # ground: flat class colour, gently mottled
    col = soft @ P
    col *= (1 + 0.02 * tone(gy, gx))[..., None]
    col *= (1 + 0.015 * grain(gy + 500, gx))[..., None]          # faint, even grass grain

    # canopy height field: overlapping soft bumps (metaballs) at jittered points in scrub
    canopy_cls = (cls == DENSE) | (cls == SCRUB)
    hfield = np.zeros((hh, ww), np.float32)
    stamps = {}
    def add_bumps(pts, r_lo, r_hi, keep_frac):
        xs, ys, u, v = pts
        sel = (xs >= gx0 - 20) & (xs < gx0 + ww + 20) & (ys >= gy0 - 20) & (ys < gy0 + hh + 20)
        for x, y, uu, vv in zip(xs[sel] - gx0, ys[sel] - gy0, u[sel], v[sel]):
            ix, iy = int(x), int(y)
            if not (0 <= ix < ww and 0 <= iy < hh) or not canopy_cls[iy, ix] or vv > keep_frac(cls[iy, ix]):
                continue
            rr = r_lo + (r_hi - r_lo) * uu
            rk = round(rr * 2) / 2
            if rk not in stamps:
                k = int(math.ceil(rk)); yy, xx = np.mgrid[-k:k + 1, -k:k + 1]
                d2 = (xx ** 2 + yy ** 2) / rk ** 2
                stamps[rk] = (np.clip(1 - d2, 0, 1) ** 2).astype(np.float32)
            st = stamps[rk]; k = st.shape[0] // 2
            y0_, x0_ = iy - k, ix - k
            sy0, sx0 = max(0, -y0_), max(0, -x0_)
            y1_, x1_ = min(hh, iy + k + 1), min(ww, ix + k + 1)
            hfield[max(0, y0_):y1_, max(0, x0_):x1_] += (0.6 + 0.8 * vv) * st[sy0:sy0 + y1_ - max(0, y0_), sx0:sx0 + x1_ - max(0, x0_)]  # bushes of different heights
    add_bumps(bush_pts, m(8), m(13), lambda c: 1.0 if c == DENSE else 0.0)
    add_bumps(scrub_pts, m(5.5), m(8.5), lambda c: 1.0 if c == SCRUB else 0.0)

    # warp the bumps with noise (two scales) so no clump is a clean circle
    dy = warp1[0](gy, gx) * m(1.6) + warp2[0](gy, gx) * m(4)
    dx = warp1[1](gy, gx) * m(1.6) + warp2[1](gy, gx) * m(4)
    yy, xx = np.mgrid[0:hh, 0:ww].astype(np.float32)
    hfield = ndimage.map_coordinates(hfield, [yy + dy, xx + dx], order=1, mode='nearest')
    hfield = 1 - np.exp(-1.6 * hfield)                         # merge overlaps into one lumpy mass
    # second octave: small leafy lumps on top of the clumps (only where there is canopy)
    leaf = np.clip(grain(gy + 1500, gx), -1.6, 1.6)
    hfield = hfield + 0.12 * leaf * np.clip(hfield / 0.3, 0, 1)

    inside = ndimage.gaussian_filter((hfield > 0.22).astype(np.float32), m(0.9))   # soft canopy mask
    hs = ndimage.gaussian_filter(hfield, m(0.9))
    gyy, gxx = np.gradient(hs)
    k = m(4.5)                                                  # bump steepness
    nx, ny, nz = -gxx * k, -gyy * k, np.ones_like(hs)
    L = np.array([-1, -1, 1.3]); L = L / np.linalg.norm(L)     # light from the NW, rows run south
    lam = np.clip((nx * L[0] + ny * L[1] + nz * L[2]) / np.sqrt(nx ** 2 + ny ** 2 + nz ** 2), 0, 1)
    q = np.floor(lam * 5.99) / 5                                # a touch posterized: drawn, not rendered
    lam = 0.75 * lam + 0.25 * q
    shade = 0.55 + 0.62 * lam                                   # strong lit / shaded sides
    shade *= 0.66 + 0.34 * np.clip(hfield / 0.75, 0, 1)         # deep crevices between clumps

    dense_w = ndimage.gaussian_filter((cls == DENSE).astype(np.float32), m(5))[..., None]
    ccol = (P[DENSE] * dense_w + P[SCRUB] * (1 - dense_w)) * (1 + 0.06 * tone(gy + 999, gx))[..., None]
    ccol = ccol * shade[..., None]
    sun = np.clip((lam - 0.72) / 0.28, 0, 1)[..., None] * 0.35  # sunlit tops warm up a little
    ccol = ccol * (1 - sun) + np.array([196, 204, 140], np.float32) * sun

    # drop shadow to the SE on the ground, then the canopy, then a soft scalloped outline
    sh = ndimage.shift(inside, (m(4.5), m(4.5)), order=1, mode='constant')
    sh = ndimage.gaussian_filter(sh, m(2))
    col *= (1 - 0.32 * sh * (1 - inside))[..., None]
    col = col * (1 - inside[..., None]) + ccol * inside[..., None]
    edge = np.clip(1 - np.abs(inside - 0.5) * 3.2, 0, 1)
    col *= (1 - 0.38 * edge)[..., None]

    # grass tufts: a few three-stroke ticks in meadow / grass, drawn at 2× and scaled down
    SS = 2
    img = Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)).resize((ww * SS, hh * SS), Image.BILINEAR)
    d = ImageDraw.Draw(img, 'RGBA')
    f, alpha = TUFT[pal]
    xs, ys, u, v = tuft_pts
    sel = (xs >= gx0) & (xs < gx0 + ww) & (ys >= gy0) & (ys < gy0 + hh)
    for x, y, uu, vv in zip(xs[sel] - gx0, ys[sel] - gy0, u[sel], v[sel]):
        c = cls[int(y), int(x)]
        if c not in (GREEN, GRASS) or vv < 0.35 or inside[int(y), int(x)] > 0.1:
            continue
        tc = tuple(int(t * f) for t in P[c]) + (alpha,)
        kk = (0.7 + 0.5 * uu) * m(1.25) * SS
        X, Y = x * SS, y * SS
        for ddx, ang in ((-3, -0.5), (0, 0), (3, 0.5)):
            Lt = 7 * kk
            d.line([X + ddx * kk * 0.5, Y, X + ddx * kk * 0.5 + math.sin(ang) * Lt, Y - math.cos(ang) * Lt], fill=tc, width=max(1, round(kk * 1.2)))
    img = img.resize((ww, hh), Image.LANCZOS)

    # alpha: parks/open space only, never water
    # extent 'bbox': all land in the frame; otherwise parks only. Developed land is cut out either way.
    mask = Image.new('L', (ww * SS, hh * SS), 255 if clip_all else 0)
    md = ImageDraw.Draw(mask)
    to_px = lambda c: ((merc(*c)[0] - X0) / res * SS - gx0 * SS, (Y1 - merc(*c)[1]) / res * SS - gy0 * SS)
    for park in (True, False):                                   # parks first, then cut out developed
        for feat, is_p in polys:
            if is_p != park:
                continue
            g = feat['geometry']
            for poly in (g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]):
                for i, ring in enumerate(poly):
                    md.polygon([to_px(c) for c in ring], fill=(255 if park else 0) if i == 0 else (0 if park else 255))
    mask = np.asarray(mask.resize((ww, hh), Image.LANCZOS), np.float32) / 255
    mask *= 1 - water
    rgba = np.dstack([np.asarray(img), (mask * 255).astype(np.uint8)])
    return Image.fromarray(rgba, 'RGBA')


if __name__ == '__main__':
    main()
