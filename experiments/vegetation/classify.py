"""Step 1: satellite (NAIP, 4 bands) → a few smoothed vegetation classes.

Features per pixel (after a small blur, so we classify patches, not leaves): colour, NDVI
(near-infrared tells living plants from dry grass), and local roughness (scrub is lumpy,
grass is smooth). k-means groups them; a mode filter cleans the class map.
"""
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

here = Path(__file__).parent
a = np.load(here / 'naip.npy').astype(np.float32) / 255
H, W, _ = a.shape


def blur(x, r):
    return ndimage.gaussian_filter(x, r)


r, g, b, nir = (blur(a[..., i], 3) for i in range(4))
ndvi = (nir - r) / (nir + r + 1e-6)
lum = (a[..., 0] + a[..., 1] + a[..., 2]) / 3
rough = np.sqrt(np.maximum(blur(lum ** 2, 6) - blur(lum, 6) ** 2, 0))

F = np.stack([r * 2, g * 2, b * 2, ndvi * 1.5, rough * 12], -1).reshape(-1, 5)
rng = np.random.default_rng(1)
sample = F[rng.choice(len(F), 60000, replace=False)]
K = 7
C = sample[rng.choice(len(sample), K, replace=False)]
for _ in range(40):
    lab = np.argmin(((sample[:, None] - C[None]) ** 2).sum(-1), 1)
    C = np.array([sample[lab == k].mean(0) if (lab == k).any() else C[k] for k in range(K)])
labels = np.concatenate([np.argmin(((F[i:i + 400000, None] - C[None]) ** 2).sum(-1), 1) for i in range(0, len(F), 400000)])
labels = labels.reshape(H, W).astype(np.uint8)

im = Image.fromarray(labels, 'L')
for _ in range(3):
    im = im.filter(ImageFilter.ModeFilter(9))
labels = np.asarray(im)
np.save(here / 'labels.npy', labels)

sat = a[..., :3]
print('k  share  rgb(sat)            ndvi   rough')
for k in range(K):
    m = labels == k
    if not m.any():
        continue
    print(k, f'{m.mean():5.1%}', np.round(sat[m].mean(0) * 255).astype(int), f'{ndvi[m].mean():.2f}', f'{rough[m].mean():.3f}')
pal = (np.array([[228, 26, 28], [55, 126, 184], [77, 175, 74], [152, 78, 163], [255, 127, 0], [255, 255, 51], [166, 86, 40]]))
Image.fromarray(pal[labels].astype(np.uint8)).save(here / '2-classes-raw.png')
