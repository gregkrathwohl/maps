"""Blender shaded relief (in the spirit of Daniel Huffman's Blender relief tutorial).

Builds a mesh straight from the DEM (one vertex per pixel), lights it with a soft sun
from the north-west, looks straight down with an orthographic camera that frames the
DEM exactly, and renders a grey 16-bit PNG that lines up with the place's bbox.

  /Applications/Blender.app/Contents/MacOS/Blender -b --python scripts/relief.py -- \
      marin-headlands [--step 2] [--exag 2] [--sun-alt 35] [--sun-az 315] [--samples 64]

Reads places/<id>/data/dem.npy + dem.json (scripts/fetch-dem.py).
Writes places/<id>/data/relief.png.
"""
import argparse, json, math, sys, time
from pathlib import Path

import bpy
import numpy as np

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument('place')
ap.add_argument('--step', type=int, default=1, help='mesh decimation (1 = every DEM pixel)')
ap.add_argument('--scale', type=float, default=1.0, help='render pixels per DEM pixel')
ap.add_argument('--exag', type=float, default=2.0, help='vertical exaggeration')
ap.add_argument('--sun-alt', type=float, default=35.0)
ap.add_argument('--sun-az', type=float, default=315.0, help='degrees clockwise from north')
ap.add_argument('--sun-soft', type=float, default=3.0, help='sun angular size, degrees')
ap.add_argument('--sun-energy', type=float, default=3.0)
ap.add_argument('--sky', type=float, default=0.35, help='ambient sky light, fills shadows')
ap.add_argument('--samples', type=int, default=64)
ap.add_argument('--out', default='relief.png')
a = ap.parse_args(argv)

t0 = time.time()
data = Path(__file__).resolve().parent.parent / 'places' / a.place / 'data'
meta = json.loads((data / 'dem.json').read_text())
z = np.load(data / 'dem.npy')[::a.step, ::a.step].astype(np.float32)
H, W = z.shape
lat = math.radians((meta['bbox'][1] + meta['bbox'][3]) / 2)
ground = meta['res'] * math.cos(lat) * a.step       # true metres per mesh cell
z = z / ground * a.exag                            # elevation in mesh-cell units

# ---- scene -------------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# ---- mesh: a regular grid, x east, y north, one unit per cell ------------------
xs = np.arange(W, dtype=np.float32) - (W - 1) / 2
ys = (H - 1) / 2 - np.arange(H, dtype=np.float32)   # row 0 is north
X, Y = np.meshgrid(xs, ys)
co = np.stack([X, Y, z], axis=-1).reshape(-1)

idx = np.arange(H * W, dtype=np.int32).reshape(H, W)
quads = np.stack([idx[:-1, :-1], idx[1:, :-1], idx[1:, 1:], idx[:-1, 1:]], axis=-1).reshape(-1)
nq = (H - 1) * (W - 1)

me = bpy.data.meshes.new('terrain')
me.vertices.add(H * W)
me.vertices.foreach_set('co', co)
me.loops.add(nq * 4)
me.loops.foreach_set('vertex_index', quads)
me.polygons.add(nq)
me.polygons.foreach_set('loop_start', np.arange(0, nq * 4, 4, dtype=np.int32))
me.update(calc_edges=True)
me.validate()
me.shade_smooth()
ob = bpy.data.objects.new('terrain', me)
scene.collection.objects.link(ob)
print(f'mesh {W}×{H} = {H * W / 1e6:.1f} M vertices  ({time.time() - t0:.0f}s)')

mat = bpy.data.materials.new('clay')
mat.use_nodes = True
bsdf = mat.node_tree.nodes['Principled BSDF']
bsdf.inputs['Base Color'].default_value = (0.8, 0.8, 0.8, 1)
bsdf.inputs['Roughness'].default_value = 1.0
for k in ('Specular IOR Level', 'Specular'):
    if k in bsdf.inputs:
        bsdf.inputs[k].default_value = 0.0
me.materials.append(mat)

# ---- light: soft sun + a dim even sky so shadows aren't black ------------------
sun = bpy.data.lights.new('sun', 'SUN')
sun.energy = a.sun_energy
sun.angle = math.radians(a.sun_soft)
sob = bpy.data.objects.new('sun', sun)
# Blender's sun points down -Z; tilt it down from vertical, then turn it toward the azimuth.
sob.rotation_euler = (math.radians(90 - a.sun_alt), 0, math.radians(180 - a.sun_az))
scene.collection.objects.link(sob)

world = bpy.data.worlds.new('sky')
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (1, 1, 1, 1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = a.sky
scene.world = world

# ---- camera: orthographic, straight down, framing the grid exactly --------------
cam = bpy.data.cameras.new('cam')
cam.type = 'ORTHO'
cam.ortho_scale = (W - 1) if W >= H else (H - 1)
cam.clip_end = 100000
cob = bpy.data.objects.new('cam', cam)
cob.location = (0, 0, float(z.max()) + 1000)
scene.collection.objects.link(cob)
scene.camera = cob

r = scene.render
r.engine = 'CYCLES'
r.resolution_x = round((W - 1) * a.step * a.scale)
r.resolution_y = round((H - 1) * a.step * a.scale)
r.resolution_percentage = 100
r.image_settings.file_format = 'PNG'
r.image_settings.color_mode = 'BW'
r.image_settings.color_depth = '16'
scene.view_settings.view_transform = 'Standard'
scene.view_settings.look = 'None'

scene.cycles.samples = a.samples
scene.cycles.use_denoising = True
try:
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'METAL'
    prefs.get_devices()
    for d in prefs.devices:
        d.use = True
    scene.cycles.device = 'GPU'
    print('devices:', [d.name for d in prefs.devices if d.use])
except Exception as e:  # noqa: BLE001
    print('GPU unavailable, using CPU:', e)

r.filepath = str(data / a.out)
print(f'rendering {r.resolution_x}×{r.resolution_y}, {a.samples} samples…')
bpy.ops.render.render(write_still=True)
print(f'wrote {r.filepath}  ({time.time() - t0:.0f}s total)')
