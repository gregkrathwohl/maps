"""Surface currents from NOAA SFBOFS (San Francisco Bay Operational Forecast System, FVCOM)
for one place, resampled onto a regular grid for the map's animated current layer.

Reads NOAA's public open-data bucket (noaa-nos-ofs-pds), newest model run of the day:
  n001..n006 = nowcast (the 6 hours before the run), f001..f048 = forecast.
Each ~57 MB file is downloaded, the top sigma layer inside the place's bbox is kept,
and the file is deleted again.

usage: python fetch-sfbofs.py <place> [YYYY/MM/DD] [run e.g. t15z]
needs: numpy, netCDF4  → places/<place>/data/currents-sfbofs.json
"""
import json, os, re, sys, tempfile, urllib.request, datetime as dt
import numpy as np, netCDF4

place = sys.argv[1] if len(sys.argv) > 1 else 'richardson-bay'
root = os.path.join(os.path.dirname(__file__), '..', 'places', place)
cfg = json.load(open(os.path.join(root, 'place.json')))
w, s, e, n = cfg.get('currents', {}).get('bbox', cfg['bbox'])  # currents may reach past the map (whole Golden Gate)
BUCKET = 'https://noaa-nos-ofs-pds.s3.amazonaws.com'
CELL = cfg.get('currents', {}).get('cell', 100)  # metres

def list_keys(day):
    listing = urllib.request.urlopen(f'{BUCKET}/?list-type=2&prefix=sfbofs/netcdf/{day}/&max-keys=1000').read().decode()
    return re.findall(r'<Key>([^<]+fields\.[nf]\d{3}\.nc)</Key>', listing)

# newest day that has a complete run (today's first run lands a few hours after 03z)
if len(sys.argv) > 2:
    day = sys.argv[2]; keys = list_keys(day)
else:
    now = dt.datetime.now(dt.timezone.utc)
    for back in range(3):
        day = (now - dt.timedelta(days=back)).strftime('%Y/%m/%d'); keys = list_keys(day)
        complete = [r for r in {re.search(r'\.(t\d\dz)\.', k).group(1) for k in keys}
                    if sum(f'.{r}.' in k and 'fields.f' in k for k in keys) >= 48]
        if complete: break
# newest run with the full 48 forecast hours uploaded
runs = sorted(r for r in {re.search(r'\.(t\d\dz)\.', k).group(1) for k in keys}
              if sum(f'.{r}.' in k and 'fields.f' in k for k in keys) >= 48)
run = sys.argv[3] if len(sys.argv) > 3 else runs[-1]
keys = sorted(k for k in keys if f'.{run}.' in k and not k.endswith('n000.nc') and not k.endswith('f000.nc'))
keys = sorted(set(keys), key=lambda k: (0 if re.search(r'fields\.n\d', k) else 1, k))  # nowcast first, then forecast
print(f'{day} {run}: {len(keys)} hourly files', flush=True)

# regular target grid
lat0 = (s + n) / 2
mx, my = 111320 * np.cos(np.radians(lat0)), 110540
nx, ny = int(np.ceil((e - w) * mx / CELL)), int(np.ceil((n - s) * my / CELL))
gx = w + (np.arange(nx) + 0.5) * CELL / mx
gy = n - (np.arange(ny) + 0.5) * CELL / my
GX, GY = np.meshgrid(gx, gy)

idx = wts = valid = None
times, U, V = [], [], []
tmp = tempfile.mkdtemp()
for k in keys:
    path = os.path.join(tmp, 'f.nc')
    urllib.request.urlretrieve(f'{BUCKET}/{k}', path)
    ds = netCDF4.Dataset(path)
    if idx is None:
        lonc = ds['lonc'][:].data - 360; latc = ds['latc'][:].data
        sel = np.where((lonc > w - 0.01) & (lonc < e + 0.01) & (latc > s - 0.01) & (latc < n + 0.01))[0]
        ex, ey = (lonc[sel] - w) * mx, (n - latc[sel]) * my
        px, py = (GX.ravel() - w) * mx, (n - GY.ravel()) * my
        # 3 nearest mesh elements per grid cell, inverse-distance weighted; no element within 1.5 cells = land
        idx = np.zeros((px.size, 3), int); dst = np.zeros((px.size, 3))
        for a in range(0, px.size, 2000):
            d2 = (px[a:a+2000, None] - ex[None]) ** 2 + (py[a:a+2000, None] - ey[None]) ** 2
            nn = np.argpartition(d2, 3, axis=1)[:, :3]
            idx[a:a+2000] = nn; dst[a:a+2000] = np.sqrt(np.take_along_axis(d2, nn, 1))
        valid = dst[:, 0] < max(CELL * 1.5, 300)  # coarse 'is this the model's water' test; the map masks land exactly
        wts = 1 / np.maximum(dst, 1); wts /= wts.sum(1, keepdims=True)
        print(f'{sel.size} mesh elements in bbox → grid {nx}×{ny} @ {CELL} m, {valid.sum()} water cells', flush=True)
    u = ds['u'][0, 0, :].data[sel]; v = ds['v'][0, 0, :].data[sel]
    t = netCDF4.num2date(ds['time'][0], ds['time'].units, only_use_cftime_datetimes=False)
    ds.close(); os.remove(path)
    gu = (u[idx] * wts).sum(1); gv = (v[idx] * wts).sum(1)
    gu[~valid] = 0; gv[~valid] = 0
    times.append(t.strftime('%Y-%m-%dT%H:%M:%SZ'))
    # compact: values only for water cells (listed once in 'water'), cm/s integers
    U.append(np.round(gu[valid] * 100).astype(int).tolist()); V.append(np.round(gv[valid] * 100).astype(int).tolist())
    print(times[-1], k.split('.')[-2], f'max {np.hypot(gu, gv).max():.2f} m/s', flush=True)

out = {'source': f'NOAA SFBOFS {day} {run}', 'bbox': [w, s, e, n], 'nx': nx, 'ny': ny, 'cell': CELL,
       'units': 'cm/s', 'water': np.flatnonzero(valid).tolist(), 'times': times, 'u': U, 'v': V,
       'nowcast': sum(bool(re.search(r'fields\.n\d', k)) for k in keys)}
json.dump(out, open(os.path.join(root, 'data', 'currents-sfbofs.json'), 'w'), separators=(',', ':'))
print('wrote currents-sfbofs.json', flush=True)
