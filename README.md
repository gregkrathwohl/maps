# trail-cartography

Trail maps in the style of the ECTA Ipswich Trails Guide (Center for Community GIS),
built entirely in the browser with MapLibre GL JS instead of ArcGIS + Illustrator.

    npm install
    node scripts/fetch-osm.mjs marin-headlands   # OSM extract via Overpass → places/<place>/data/osm.geojson
    node serve.mjs                               # http://localhost:5190/?place=marin-headlands

- `src/palette.js` – colours sampled from the Ipswich guide
- `src/style.js` – style builder; `web` (detail by zoom) vs `paper` (one design, scales like print)
- `src/labels.js` – hand-placed HTML labels; tick "Edit labels", drag, alt-click to add; saves to `places/<place>/labels.json`
- `places/<place>/place.json` – bbox, centre, design zoom, name (must match the OSM boundary used for the outside wash)

Map library: http://localhost:5190/library.html (lists every `places/<id>/place.json`).

## Next up (as of 2026-11-16)

Iterating on the two maps:
- Line hierarchy: road vs. trail vs. informal trail, and major vs. minor trails (fire roads, named trails, singletrack)
- Place labels: fix positions; make them behave in Paper mode as you zoom; more hand placement
- Hillshade matters out West: Ipswich look without it, but hills need relief

New maps:
- Richardson Bay kayaking map: launch spots, routes out to Angel Island. A water map, not a trail map.
  Later: an expanded Bay version.

Pipeline:
- Blender hillshade: USGS 3DEP export for the bbox → rasterio → `blender -b -P` → georeferenced PNG layer.
  Local first (M2, 8 GB RAM: keep DEM ≲ 4000 px), later GitHub Actions.
- One-click render: same design → PDF poster / foldable / in-app raster tiles, all georeferenced.

## Blender shaded relief

    .venv/bin/pip install numpy pillow tifffile
    brew install --cask blender
    .venv/bin/python scripts/fetch-dem.py marin-headlands 5     # USGS 3DEP lidar, Web Mercator, 5 m/px → data/dem.tif + dem.npy
    /Applications/Blender.app/Contents/MacOS/Blender -b --python scripts/relief.py -- marin-headlands
    .venv/bin/python scripts/relief-web.py marin-headlands      # grey render → transparent shadow/highlight PNG, adds "relief" to place.json

`relief.py` builds a mesh straight from the DEM (one vertex per pixel), lights it with a soft
NW sun plus dim sky, and renders straight down with an orthographic camera, so the image lines
up with the bbox exactly (the DEM is fetched in Web Mercator, the map's own projection).
Options: `--exag` (vertical exaggeration, 2), `--sun-alt`/`--sun-az`, `--sun-soft`, `--sky`,
`--samples`, `--step 2` for a quick half-res test. On the M2 / 8 GB: ~7 min at half-res mesh.
`relief-web.py` options: `--shadow`, `--light`, `--tint`, `--gamma`. Toggle "Blender" in the
dev toolbar to compare with the browser's own hillshade.

## Water maps (style: "bay")

    node scripts/fetch-osm.mjs <place>     # OSM incl. coastline, beaches, launches
    node scripts/fetch-aton.mjs <place>    # NOAA ENC buoys/beacons (+ places/<place>/aton-extra.json)
    node scripts/coast.mjs <place>         # join + smooth coastline
    node scripts/water.mjs <place>         # land mask → distance field → ripples.geojson + navgrid (router)
    node scripts/routes.mjs <place>        # launch/landing spots from routes.json

Saved routes live in `places/<place>/trips.json` (stops: "aton:<name>", "osm:<name>" or [lon,lat]);
the in-browser planner routes legs around land (A* on navgrid, ≥ N m off shore) and saves back to it.

### Currents (NOAA SFBOFS)

    python3 -m venv .venv && .venv/bin/pip install numpy netCDF4
    .venv/bin/python scripts/fetch-sfbofs.py richardson-bay          # newest run today: 6 h nowcast + 48 h forecast

Streams ~54 hourly model files (~57 MB each) from NOAA's open-data bucket, keeps the surface
layer inside the bbox on a 100 m grid, deletes each file. The map animates it (src/flow.js).
Tick "Grid" on a bay map to see the router's water grid and the cells a route search explored.

## Publishing (GitHub Pages)

    node scripts/build.mjs      # → dist/: library at index.html, map.html in public mode (no dev tools)
    # then push dist/ to the gh-pages branch (see scripts/deploy.sh)

Live: https://gregkrathwohl.github.io/maps/
