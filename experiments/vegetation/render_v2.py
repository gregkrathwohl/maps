"""Step 2: vegetation classes → a schematic, painterly land-cover layer.

Flat colours borrowed from the satellite (lightened toward the map's paper), organic
smoothed edges, a stamped texture per class (bush blobs, grass ticks, stipple), the Blender
relief multiplied on top, and OSM trails for orientation. Writes a 3-up comparison.
"""
import json, math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage

here = Path(__file__).parent
root = here.parent.parent
labels = np.load(here / 'labels.npy')
naip = np.load(here / 'naip.npy')[..., :3]
H, W = labels.shape
w, s, e, n = map(float, (here / 'bbox.txt').read_text().split(','))
R = 6378137.0
merc = lambda lon, lat: (R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)))
X0, Y0 = merc(w, s); X1, Y1 = merc(e, n)
px = lambda lon, lat: ((merc(lon, lat)[0] - X0) / (X1 - X0) * W, (Y1 - merc(lon, lat)[1]) / (Y1 - Y0) * H)

# k-means cluster → class (read off the cluster table + class map)
DENSE, SCRUB, GREEN, GRASS, DRY, BARE = range(6)
remap = np.array([BARE, DRY, DENSE, GREEN, GRASS, DRY, SCRUB], dtype=np.uint8)
cls = remap[labels]
lum = naip.astype(np.float32).mean(-1) / 255
rough = ndimage.gaussian_filter(np.sqrt(np.maximum(ndimage.gaussian_filter(lum ** 2, 6) - ndimage.gaussian_filter(lum, 6) ** 2, 0)), 6)
cls[(cls == DENSE) & (rough < np.percentile(rough[cls == DENSE], 45))] = GREEN
cls[cls == BARE] = DRY   # trails are drawn anyway; bare specks just add noise

# organic edges: blur each class mask, take the strongest
stack = np.stack([ndimage.gaussian_filter((cls == k).astype(np.float32), 9) for k in range(6)])
cls = stack.argmax(0).astype(np.uint8)

paper = np.array([251, 250, 246], np.float32)
sat_mean = np.array([naip[cls == k].mean(0) if (cls == k).any() else paper for k in range(6)], np.float32)
# lighten toward paper and nudge saturation up a little: "inspired by", not a photo
mixf = np.array([0.42, 0.5, 0.58, 0.62, 0.66, 0.75])[:, None]
base = sat_mean * (1 - mixf) + paper * mixf
grey = base.mean(1, keepdims=True)
base = np.clip(grey + (base - grey) * 1.6, 0, 255)

SS = 2  # supersample for smooth stamps
img = Image.fromarray(base[cls].astype(np.uint8)).resize((W * SS, H * SS), Image.NEAREST)
draw = ImageDraw.Draw(img, 'RGBA')
rng = np.random.default_rng(7)
dark = lambda c, f: tuple(int(v * f) for v in c)


def scatter(mask, spacing):
    """roughly even random points inside a class (jittered grid)"""
    ys, xs = np.mgrid[0:H:spacing, 0:W:spacing]
    xs = xs + rng.uniform(0, spacing, xs.shape); ys = ys + rng.uniform(0, spacing, ys.shape)
    xs, ys = xs.ravel(), ys.ravel()
    ok = (xs < W) & (ys < H)
    xs, ys = xs[ok], ys[ok]
    keep = mask[ys.astype(int), xs.astype(int)]
    return list(zip(xs[keep], ys[keep]))


def bush(x, y, r, col):
    x, y, r = x * SS, y * SS, r * SS
    draw.ellipse([x - r + r * 0.35, y - r + r * 0.35, x + r + r * 0.35, y + r + r * 0.35], fill=dark(col, 0.62) + (150,))  # shadow, SE
    draw.ellipse([x - r, y - r, x + r, y + r], fill=col + (255,), outline=dark(col, 0.7) + (255,), width=max(1, SS))
    draw.ellipse([x - r * 0.55, y - r * 0.65, x - r * 0.05, y - r * 0.2], fill=tuple(min(255, int(v * 1.12)) for v in col) + (170,))  # highlight, NW


# bigger, fewer stamps: a bush is drawn ~10–14 m across, stylised rather than literal
pts = sorted(scatter(cls == DENSE, 10), key=lambda p: p[1])
for x, y in pts:
    bush(x, y, rng.uniform(6.5, 9.0), dark(tuple(int(v) for v in base[DENSE]), rng.uniform(0.84, 0.96)))
for x, y in sorted(scatter(cls == SCRUB, 17), key=lambda p: p[1]):
    bush(x, y, rng.uniform(4.5, 6.5), dark(tuple(int(v) for v in base[SCRUB]), rng.uniform(0.86, 0.97)))
# grass: a few tufts only, no stipple on dry grass
col = dark(tuple(int(v) for v in base[GREEN]), 0.7) + (200,)
for x, y in scatter(cls == GREEN, 30):
    x, y = x * SS, y * SS
    for dx, ang in ((-3, -0.5), (0, 0), (3, 0.5)):
        L = 7 * SS
        draw.line([x + dx * SS * 0.5, y, x + dx * SS * 0.5 + math.sin(ang) * L, y - math.cos(ang) * L], fill=col, width=SS + 1)
img = img.resize((W, H), Image.LANCZOS)
veg = np.asarray(img, np.float32)

# Blender relief, multiplied (cropped from the Headlands render)
place = json.loads((root / 'places/marin-headlands/place.json').read_text())
rw, rs, re_, rn = place['relief']['bbox']
rel = Image.open(root / 'places/marin-headlands/data/relief-grey.png')
RX0, RY0 = merc(rw, rs); RX1, RY1 = merc(re_, rn)
box = ((X0 - RX0) / (RX1 - RX0) * rel.width, (RY1 - Y1) / (RY1 - RY0) * rel.height,
       (X1 - RX0) / (RX1 - RX0) * rel.width, (RY1 - Y0) / (RY1 - RY0) * rel.height)
shade = np.asarray(rel.resize((W, H), Image.BICUBIC, box=box), np.float32) / 255
flat = place['relief']['flat']
d = np.clip((flat - shade) / flat, 0, 1)[..., None] * 0.75       # shadow amount
l = np.clip((shade - flat) / (1 - flat), 0, 1)[..., None] * 0.35   # highlight amount
tint = np.array([62, 80, 70], np.float32)                           # cool shadow, keeps colour
lit = lambda c: np.clip(c * (1 - d) + tint * d * (c / 255) ** 0.5 * 0 + c * tint / 255 * d, 0, 255) * (1 - l) + 255 * l
out = lit(veg).astype(np.uint8)
flatcols = lit(base[cls]).astype(np.uint8)

# trails
osm = json.loads((root / 'places/marin-headlands/data/osm.geojson').read_text())


def trails(im, width):
    d = ImageDraw.Draw(im)
    for f in osm['features']:
        p, g = f['properties'], f['geometry']
        if p.get('highway') not in ('path', 'track', 'footway', 'bridleway', 'service') or g['type'] != 'LineString':
            continue
        xy = [px(*c) for c in g['coordinates']]
        if all(not (0 <= x <= W and 0 <= y <= H) for x, y in xy):
            continue
        d.line(xy, fill=(184, 65, 74), width=width, joint='curve')
    return im


final = trails(Image.fromarray(out), 5)
final.save(here / 'v2-schematic.png')
flat_im = trails(Image.fromarray(flatcols), 4)
flat_im.save(here / 'v2-flat.png')

# 3-up comparison
sat = Image.open(here / '1-satellite.jpg')
tw = 900; th = round(H * tw / W)
panels = [(sat, 'Satellite (USGS NAIP)'), (flat_im, 'Simplified: 6 classes, flat colour + relief'), (final, 'Schematic: stamped textures + relief')]
sheet = Image.new('RGB', (tw * 3 + 40, th + 50), (251, 250, 246))
d = ImageDraw.Draw(sheet)
try:
    font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 20)
except OSError:
    font = ImageFont.load_default()
for i, (im, title) in enumerate(panels):
    sheet.paste(im.resize((tw, th), Image.LANCZOS), (10 + i * (tw + 10), 40))
    d.text((10 + i * (tw + 10), 10), title, fill=(40, 40, 40), font=font)
sheet.save(here / 'v2-comparison.jpg', quality=90)
print('wrote comparison.jpg', sheet.size)
