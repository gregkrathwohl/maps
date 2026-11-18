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

# organic edges: blur each class mask, take the strongest
stack = np.stack([ndimage.gaussian_filter((cls == k).astype(np.float32), 4) for k in range(6)])
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


# dense scrub & riparian: packed bushes, drawn top to bottom so lower ones overlap
pts = sorted(scatter(cls == DENSE, 5), key=lambda p: p[1])
for x, y in pts:
    bush(x, y, rng.uniform(3.2, 5.0), dark(tuple(int(v) for v in base[DENSE]), rng.uniform(0.82, 0.97)))
# coastal scrub: smaller, looser bushes
for x, y in sorted(scatter(cls == SCRUB, 7), key=lambda p: p[1]):
    bush(x, y, rng.uniform(2.0, 3.4), dark(tuple(int(v) for v in base[SCRUB]), rng.uniform(0.85, 0.98)))
# green grass: little tufts (three short strokes)
for k, sp, f in ((GREEN, 9, 0.72), (GRASS, 11, 0.74)):
    col = dark(tuple(int(v) for v in base[k]), f) + (210,)
    for x, y in scatter(cls == k, sp):
        x, y = x * SS, y * SS
        for dx, ang in ((-2.2, -0.45), (0, 0), (2.2, 0.45)):
            L = 4.5 * SS
            draw.line([x + dx * SS * 0.5, y, x + dx * SS * 0.5 + math.sin(ang) * L, y - math.cos(ang) * L], fill=col, width=SS)
# dry grass: sparse stipple
col = dark(tuple(int(v) for v in base[DRY]), 0.7) + (190,)
for x, y in scatter(cls == DRY, 6):
    draw.ellipse([x * SS - SS * 0.7, y * SS - SS * 0.7, x * SS + SS * 0.7, y * SS + SS * 0.7], fill=col)

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
mult = np.clip(1 + (shade - flat) * 0.9, 0.45, 1.15)[..., None]
out = np.clip(veg * mult, 0, 255).astype(np.uint8)
flatcols = np.clip(base[cls] * mult, 0, 255).astype(np.uint8)

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


final = trails(Image.fromarray(out), 4)
final.save(here / '4-schematic.png')
flat_im = trails(Image.fromarray(flatcols), 4)
flat_im.save(here / '3-flat-classes.png')

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
sheet.save(here / 'comparison.jpg', quality=90)
print('wrote comparison.jpg', sheet.size)
