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
