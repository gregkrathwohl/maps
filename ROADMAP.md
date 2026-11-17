# Trail cartography: where things come from, and where this could go

_Updated 2026-11-17. Exploring phase: see what's possible, what's fun, then polish and publish._

## The idea

One set of data + one design → every format: interactive web map, big print poster,
folding map, in-app map, all georeferenced and identical. No Illustrator
step; the design *is* the code. Places so far: Marin Headlands, Angel Island
(trail guides) and Richardson Bay (paddling guide).

## Where the data comes from

| Layer | Source | How it gets in |
|---|---|---|
| Trails, roads, buildings, beaches, wetlands, park boundaries, launches | OpenStreetMap (free, editable by anyone) | `scripts/fetch-osm.mjs`: one Overpass query per place's bbox → `data/osm.geojson` |
| Ocean & bay polygons | OpenFreeMap vector tiles (OSM-derived) | streamed live by the map |
| Land elevation **and bay depth** | AWS Terrain Tiles (Mapzen "Terrarium": USGS 3DEP on land, NOAA bathymetry in the bay) | streamed live; contours and depth contours generated in the browser by `maplibre-contour`; depth shading via MapLibre `color-relief` |
| Buoys, beacons, lights | NOAA Electronic Navigational Charts (ENC Direct, harbour scale), public domain | `scripts/fetch-aton.mjs` → `data/aton.geojson`; extra marks (YRA racing buoys) in `aton-extra.json` |
| Coastline used for ripples + routing | OSM coastline, joined + smoothed | `scripts/coast.mjs` → `data/coast.geojson` |
| Ripples (waterlining) + the router's water grid | derived: land mask → distance to shore for every 6 m cell | `scripts/water.mjs` → `data/ripples.geojson`, `data/navgrid.png` |
| Place names, area names, numbered locators | hand-placed by us | `labels.json`, dragged in the label editor |
| Saved paddling routes | us | `trips.json`, from the route planner |

## Near-term polish (per map)

- **Trail maps:** line hierarchy (road / fire road / trail / informal, major vs minor);
  label positions and how they behave in Paper mode; more hand placement.
- **Bay map:** ripples vs depth lines (or both); depth intensity; label for Belvedere's tip;
  more launches; buoy-label density.
- **Route planner:** edit a saved route (drag stops, insert, delete), rename/delete routes,
  show several routes at once, per-leg bearings, export GPX for a watch/phone.
- **Router:** depth-aware (avoid mudflats at low tide), stay out of shipping lanes,
  optionally current-aware once we have currents (below).

## Currents: four levels of ambition

1. **Real predictions at a few points (easy).** NOAA CO-OPS publishes tidal-current
   predictions for stations such as Raccoon Strait and the Golden Gate: max flood/ebb,
   slack times, speeds. Good for a "today's tides" panel or arrows at those stations.
   Exact, but only at points.

2. **Physics-flavoured proxy from data we already have (fun, cheap).** Your idea, sharpened:
   - *Direction:* the water has to get in and out through the Golden Gate. On the
     navgrid, compute the through-water distance from every cell to the Gate (one Dijkstra /
     fast-marching pass, the same machinery as the router). Flow follows that distance
     field's gradient: out on the ebb, in on the flood.
   - *Strength:* conservation of water. All the water "behind" a cross-section (the tidal
     prism, i.e. the bay area farther from the Gate × tidal range) has to squeeze through it,
     so speed ≈ prism ÷ cross-section area. Within a cross-section the deep part runs fastest
     (roughly speed ∝ depth^⅔). That's why Raccoon Strait and the Gate rip and Richardson Bay
     is lazy, without a single simulation step.
   - Draw it as streamlines/wisps, or animated particles on the web. Honest limits: no
     eddies, no counter-currents, no timing (slack lags the tide); it's a picture of where the
     big flow goes.

3. **Real model output (the best data for the effort).** NOAA runs SFBOFS, an operational
   hydrodynamic model of San Francisco Bay (FVCOM), and publishes currents on its mesh
   as hourly NetCDF, nowcast plus a ~48 h forecast, free on NOAA's open-data buckets. That's the same
   class of model the commercial apps build on. Pipeline: fetch → interpolate onto our grid
   → (a) static "typical max ebb / max flood" maps for print, (b) animated particles through
   a tide cycle on the web, (c) current-aware routing ("leave Swede's at 10:40 and ride the flood").

4. **Our own simulation (research toy).** A 2-D shallow-water solver on the GPU (WebGPU),
   with our bathymetry and a tidal boundary at the Golden Gate. Totally doable as a playful
   demo, and it would show counter-currents and eddies forming live. It won't beat SFBOFS for accuracy,
   but it's a great way to *understand* the bay.

Suggested order: 2 (looks great on the static map), then 3 (truth + animation), keep 4 for fun.

**How currents should look (Greg, 2026-11-17):** a *living background*, not the main event.
Thin, uncoloured, light lines drifting through the water, much quieter than PredictWind.
Encode strength with motion, not colour: faster/longer/more frequent streaks where the
current is strong, sparse and slow where it's weak. A time scrubber to slide through past
and forecast hours (SFBOFS nowcast + 48 h). Same treatment later for wind. The NOAA viewers
show the data in an ugly way; the point is the same truth, drawn beautifully.

## Turning these into finished maps

1. **Design pass per place:** labels, hierarchy, colours, legend, title block.
2. **Hillshade:** Blender render from USGS 3DEP 1 m lidar → georeferenced image layer.
3. **Render once, at print resolution:** headless browser at the design zoom × 4–8 →
   GeoTIFF + GeoPDF (poster, foldable, Avenza) → raster tiles (PMTiles) for a fast,
   identical in-app map with live layers (GPS dot, routes) on top.
4. **Publish:** static site with the library; each map = web viewer + PDF download.
5. **One-click:** the scripts above + render + publish as one pipeline (local first,
   GitHub Actions later) so a new place is: bbox → name → hand labels → done.

## Ideas parking lot

- Ipswich-style "town map with trail systems sprinkled around it" (multiple park boundaries).
- Race maps: course + mile markers + aid stations on the same base.
- Your own Strava activities as a "where I've actually been" layer: a separate overlay
  (not part of the route tools), kayak / paddleboard / swim only, all tracks drawn faintly
  so they add up to a personal heat map, hover or scroll a list to highlight one.
  Data: Strava account export for everything (hundreds of kayaks); the Strava connector
  is fine for a quick first pass at the last year or so.
- Mt. Tam, Ipswich/Willowdale, an expanded SF Bay paddling map.
