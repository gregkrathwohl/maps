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
