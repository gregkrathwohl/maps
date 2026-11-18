"""Download a USGS 3DEP elevation model for a place, in Web Mercator.

The 3DEP ImageServer is natively EPSG:3857 at ~1 m, so asking for a 3857 bbox gives a
grid that lines up exactly with a MapLibre image source (corners = bbox corners).

  .venv/bin/python scripts/fetch-dem.py marin-headlands [metres-per-pixel=5]

Writes places/<id>/data/dem.tif (float32, metres) and dem.json (bbox, size).
"""
import json, math, sys, urllib.parse, urllib.request
from pathlib import Path

import numpy as np
import tifffile

URL = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage'
R = 6378137.0


def merc(lon, lat):
    return R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def main():
    place = sys.argv[1]
    res = float(sys.argv[2]) if len(sys.argv) > 2 else 5.0  # mercator metres per pixel
    root = Path(__file__).resolve().parent.parent / 'places' / place
    cfg = json.loads((root / 'place.json').read_text())
    w, s, e, n = cfg.get('relief', {}).get('bbox', cfg['bbox'])
    x0, y0 = merc(w, s)
    x1, y1 = merc(e, n)
    W, H = round((x1 - x0) / res), round((y1 - y0) / res)
    if max(W, H) > 8000:
        sys.exit(f'{W}×{H} is over the service limit of 8000; use a coarser resolution')
    q = {
        'bbox': f'{x0},{y0},{x1},{y1}', 'bboxSR': 3857, 'imageSR': 3857, 'size': f'{W},{H}',
        'format': 'tiff', 'pixelType': 'F32', 'interpolation': 'RSP_BilinearInterpolation',
        'noDataInterpretation': 'esriNoDataMatchAny', 'f': 'image',
    }
    print(f'requesting {W}×{H} @ {res} m (mercator)…')
    req = urllib.request.Request(URL + '?' + urllib.parse.urlencode(q), headers={'User-Agent': 'trail-cartography'})
    data = urllib.request.urlopen(req, timeout=300).read()
    out = root / 'data' / 'dem.tif'
    out.write_bytes(data)
    z = tifffile.imread(out).astype(np.float32)
    z[(z < -100) | ~np.isfinite(z)] = np.nan
    # Blender's bundled Python has numpy but no TIFF reader: hand it a .npy too.
    # Sea and gaps go to 0 (relief is land-only; water is drawn over it).
    np.save(root / 'data' / 'dem.npy', np.nan_to_num(np.maximum(z, 0), nan=0.0))
    print(f'{z.shape[1]}×{z.shape[0]}  min {np.nanmin(z):.1f} m  max {np.nanmax(z):.1f} m  nodata {np.isnan(z).mean():.1%}')
    (root / 'data' / 'dem.json').write_text(json.dumps({'bbox': [w, s, e, n], 'size': [W, H], 'res': res}))


main()
