"""Prepare the Blender render for the web map.

Writes data/relief-grey.png (8-bit grey; the browser turns it into transparent shadows and
highlights live, so those can be tuned with sliders) and records it in place.json "relief",
with the flat-ground grey level and the bake settings used.

  .venv/bin/python scripts/relief-web.py marin-headlands [--bake '{"exag":2,...}']
"""
import argparse, json
from pathlib import Path

import numpy as np
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument('place')
ap.add_argument('--src', default='relief.png')
ap.add_argument('--bake', default=None, help='JSON of the Blender settings used, stored for the tuner')
a = ap.parse_args()

root = Path(__file__).resolve().parent.parent / 'places' / a.place
data = root / 'data'
v = np.asarray(Image.open(data / a.src).convert('I'), dtype=np.float32) / 65535.0
dem = np.load(data / 'dem.npy')
sea = np.asarray(Image.fromarray((dem <= 0).astype(np.uint8) * 255).resize((v.shape[1], v.shape[0]), Image.NEAREST)) > 0
flat = float(np.median(v[sea])) if sea.any() else float(np.median(v))
Image.fromarray((v * 255 + 0.5).clip(0, 255).astype(np.uint8), 'L').save(data / 'relief-grey.png', optimize=True)

cfg = json.loads((root / 'place.json').read_text())
meta = json.loads((data / 'dem.json').read_text())
old = cfg.get('relief', {})
cfg['relief'] = {
    'image': 'data/relief-grey.png', 'bbox': meta['bbox'], 'flat': round(flat, 4),
    'bake': json.loads(a.bake) if a.bake else old.get('bake', {}),
    'look': old.get('look', {}),
}
(root / 'place.json').write_text(json.dumps(cfg, indent=1, ensure_ascii=False) + '\n')
print(f'flat ground {flat:.3f}; wrote relief-grey.png {v.shape[1]}×{v.shape[0]} '
      f'({(data / "relief-grey.png").stat().st_size / 1e6:.1f} MB)')
