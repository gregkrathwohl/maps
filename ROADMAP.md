# Trail cartography: where things come from, and where this could go

_Updated 2026-11-17. Exploring phase: see what's possible, what's fun, then polish and publish._

## The idea

One set of data + one design → every format: interactive web map, big print poster,
folding map, in-app map, all georeferenced and identical. No Illustrator
step; the design *is* the code. Places so far: Marin Headlands, Angel Island
(trail guides) and Richardson Bay (paddling guide).

## Idea list (Greg, 2026-11-17)

No fixed order yet; Blender first.

1. **Our own simplified current model** so the map doesn't depend on the daily NOAA pull.
   Tides are predictable centuries ahead because they're a sum of ~37 regular cycles
   (constituents: M2 lunar 12.42 h, S2 solar 12 h, K1/O1 daily, …) fitted at a gauge.
   Currents work the same way. Three levels:
   - *One pattern, flipped:* one SFBOFS flood snapshot × a signed tide signal (NOAA's
     Golden Gate current prediction). Crude, surprisingly convincing.
   - *Two patterns:* a real flood field and a real ebb field, each scaled by that signal.
     Gets the asymmetry (ebb jets out the Gate, flood fans in; eddies sit in different places).
   - *Harmonics per cell (the good one):* fit ~6 constituents (M2, S2, N2, K1, O1, M4) to
     u and v at every grid cell from a month of archived SFBOFS output. Then compute
     currents for any date in the browser, forever. Slack sweeps across the map (Richardson
     Bay turns before the channel), spring/neap and the daily inequality come for free.
     About 24 numbers per cell instead of 96: ~1 MB instead of 16 MB, so it also helps
     mobile. Misses only weather (wind, big Delta outflow). Keep SFBOFS as an optional
     "live" overlay.
   It won't look different from today's map; it's about robustness, any-date scrubbing and page weight.
2. **Keep polishing the Richardson Bay map** (see Near-term polish below).
3. **Expand to all of San Francisco Bay and the coast.** Needs binary or tiled currents
   and a coarser or tiled routing grid.
4. **Mobile:** page weight (~30 MB now), touch for the tide graph and route planner, layout.
5. **Blender shaded relief** for the Headlands and Angel Island. Working (2026-11-17): the M2
   renders the Headlands at full res in ~2 min, so no cloud machine needed. Tunable in the dev
   viewer ("Tune relief": live look sliders + Re-bake). Greg's verdict: nice, keep it, but at
   gentle settings not dramatically better than a GDAL hillshade. Where it could shine:
   - **Finer resolution:** 2–3 m DEM (the 3DEP lidar goes to 1 m).
   - **Swiss / alpenglow look:** Imhof-style: warm, sunset-tinted highlights on the high
     ridges, cool shadows, a hint of elevation colour. Mostly doable live in the browser
     (tint by brightness and elevation), no re-render.
   - **Render the map itself in Blender** (the East of Nowhere look, eastofnowhere.co:
     old USGS/state maps with dramatic relief): use our finished map as the surface's colour
     texture, so the map gets real shadows instead of having a shadow layer laid over it.
     Strong exaggeration + low sun. Great for posters.
6. **Ski-map / panorama view** (Berann-style): the trails seen from a viewpoint, e.g. from
   SFRC looking over the ridges and valleys, like a ski-resort map, not geographically exact
   but readable. Blender can do a first version: perspective camera, our map draped on the
   terrain. The hand-bent "make it read better" part is the art.
   Related: just rotating maps to an unusual orientation (e.g. "the view from home").
7. **Painterly vegetation layer:** a schematic land-cover texture between the ECTA flats and
   a satellite photo: brush vs grassland vs forest vs sand, with colour and texture but
   simplified, like architectural-drawing tree squiggles. Two routes to try: (a) start from a
   satellite image and simplify (cluster colours into a few classes, smooth, posterize);
   (b) start from land-cover data (OSM landuse/natural, USGS/NLCD, CalVeg) and draw stamped
   textures per class, borrowing colours from the satellite image. First step: a small
   mock-up to check this is the look Greg means. Keep the ECTA style as the default;
   new looks are extra layers / options.
   **Status (2026-11-18):** working as a dev-only layer (toolbar → Vegetation: green / golden /
   autumn). `scripts/vegetation.py` is procedural, not AI: NAIP 4-band → classes from NDVI +
   roughness → flat class colours + a lumpy, noise-warped, NW-lit canopy (no visible circles) +
   sparse tufts, clipped to parks, as 15 WebP tiles under the Blender relief. Autumn palette is
   from Greg's photo (rosy-brown grass, olive scrub). Next: tune per Greg; a few distinct
   tree shapes (eucalyptus, cypress); not published yet.
   Greg's notes (2026-11-18): looks best around z13.5–15; zoomed out it's busy and the red
   trails get lost (opacity slider + optional zoomed-out fade added; a generalised low-zoom
   version is an option); autumn and green palettes are the keepers, golden isn't golden
   enough; contours off with vegetation; Blender highlights look odd over it (shadows only);
   some false scrub along Bobcat Trail (classification); cap zoom near 15.
8. **parkrun course maps** in this style: small, pretty, one per course.
9. **More ECTA-style trail maps:** other places, and doing more with the existing ones.
10. **Our own tiles:** ECTA-style tiles for a region rather than one map at a time. Lower
    priority: the point is trails and parks, not cities.
11. **A real app:** saved routes (Firestore), trail locations, maybe GPS on the map.

## The big vision: a trail-map builder (Greg, 2026-11-18)

After a few more rounds on the Headlands map, turn the pipeline into an app:
1. Open a map of the US, zoom to a park or trail area, click it.
2. Generate the map automatically: OSM trails/roads/parks, DEM relief, vegetation, all with
   the ECTA-style defaults.
3. Edit it: layer controls (vegetation palette/opacity, hillshade, contours), and a real
   label editor (add/remove/move/rotate/resize). Priorities: **trail names and peaks** (so
   you can say "up Bobcat, down Miwok, up Coastal, down Fox"); area names like Gerbode
   Valley are background.
4. Add points of interest, then publish: a web map / app anyone can open.
Greg does the hand-tweaking (labels etc.) himself; the job here is the editor + good defaults.

**Built so far (2026-11-18):** editor v1 (sidebar, autosave to the place's files, Preview) and
New map v1 (`new.html`: search, frame ≤ 25 km, name → `/api/new` makes a draft place, pulls
OSM via Overpass, picks + merges the parks (`scripts/parks.mjs`) → opens in the editor).
Drafts stay out of the published build. Next: map info (title / subtitle / areas / parks) in
the editor, style presets (ECTA, Swiss, National Geographic, NPS), curated layer controls +
raw style override, label everything (trails, peaks, POIs) with toggles, background jobs for
relief + vegetation, PDF export.

**Size limits:** one GeoJSON per map works up to ~25 km across (Mt. Tam frame: 10 × 12.5 km,
6,659 features, 7 MB; Overpass took ~8 min on a busy day). Yosemite / Grand Canyon scale
(50–100+ km) needs tiled data: OSM → vector tiles (PMTiles), and our own Overpass or a
Geofabrik extract instead of the public servers.

**Extent (Greg, 2026-11-18):** keep it simple: a new map's extent is the rectangle you framed
(`"extent": "bbox"`). Later, an extent option: a park (scripts/parks.mjs already picks + merges
parks), an administrative boundary (town, county), or an uploaded custom shape. It only drives
the grey outside wash.

**Big areas, the plan:** still download only the OSM we need, then make our own vector tiles
(tippecanoe / PMTiles) instead of one GeoJSON. Two kinds: heavy "editor" tiles with everything
at every zoom, so all choices stay open while designing; and lean "published" tiles where the
style decisions (which layers, from which zoom, simplification) are baked in. No world-wide
tile infrastructure needed: one park at a time.

Next places to try the vegetation layer on: **Bolinas Ridge** (Mt. Tam), classic golden grass.

## Label + editing ideas (Greg, 2026-11-18)

- **Model for now:** two owners. MapLibre places a name automatically until you click it; then
  it's a pinned hand label you own (drag, size, rotate, style). Deleting it hands it back.
- **Per-feature overrides (maybe later):** keyed by OSM id (rename / hide / priority via
  `symbol-sort-key`) while MapLibre keeps placing them. Fixes "taking over one road label hides
  every copy". A third state to explain, so only if the two-owner model starts to chafe.
- **Freeze labels (print style):** one button pins everything MapLibre is showing at the current
  zoom, exactly where it put it, then you hand-fix the draft like a print cartographer. Must use
  MapLibre's own placement (internal symbol buckets / placement index: anchors, glyph angles,
  collision results), *not* our own re-placement, or labels jump the moment you freeze. Isolate
  the internals in one file (unsupported API). Points are exact via the public API already;
  curved line labels need our own text-on-path rendering (SVG textPath), also wanted for
  curved valley / creek names.
- **AI editing:** a prompt box next to the hand controls ("make the trails thinner and darker
  green", "hide building outlines below z14") that edits the underlying style / settings
  directly, including things the editor doesn't expose.
- **Style presets:** ECTA first, then National Park (the NPS cartographic look, no gimmicks),
  Swiss, National Geographic… each built by studying real maps and listing their design patterns.

## Water for trail maps (Greg, 2026-11-18)

Trail maps shouldn't have flat teal water. Done: Water section (texture: waves; depth tint
from the Terrarium DEM's NOAA bathymetry; depth lines). Still to try:
- **Shore ripples** (waterlines) like the Richardson Bay map: needs `scripts/water.mjs` run per
  place (coast + buffers); could become a "Generate ripples" button like vegetation.
- **Textured / painted water** that matches the painted land (Vegetation style): a stylised,
  slightly mottled sea, maybe brush strokes following the depth contours.
- **Currents** for coastal trail maps (Angel Island: Raccoon Strait).
- Curate these into the map styles so each style starts with a good water look.

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

## Print PDFs: raster now, vector later (Greg, 2026-11-20)

Today the map's **Download PDF** button (src/pdf.js) is raster: MapLibre draws the sheet with the GPU (WebGL) in
tiles at the native paper zoom × 2, the pixels go straight into the PDF as JPEGs (one rasterization, no second
pass). Sharp at any real print size; soft only if you zoom far into the PDF on screen.

Come back to: **a hybrid vector PDF** for really polished prints and hand-finishing in Illustrator.
- Raster underneath: hillshade, land/water fills, contours (dense; as vectors they'd make Illustrator crawl).
- Vector on top: trails, roads, all text with embedded fonts: razor-sharp when zoomed, editable by hand.
- Cost: MapLibre has no vector export, so we'd redraw OSM features into the PDF ourselves, matching the style
  (widths, dashes, colours, label positions; MapLibre's placed labels can be read back with queryRenderedFeatures).
- Bigger question it raises: how much control needs a real vector editing tool vs. staying in MapLibre. So far
  MapLibre + hand labels (rotation, spacing, region/ridge styles) covers it.

## Ideas parking lot

- Ipswich-style "town map with trail systems sprinkled around it" (multiple park boundaries).
- Race maps: course + mile markers + aid stations on the same base.
- Your own Strava activities as a "where I've actually been" layer: a separate overlay
  (not part of the route tools), kayak / paddleboard / swim only, all tracks drawn faintly
  so they add up to a personal heat map, hover or scroll a list to highlight one.
  Data: Strava account export for everything (hundreds of kayaks); the Strava connector
  is fine for a quick first pass at the last year or so.
- Mt. Tam, Ipswich/Willowdale, an expanded SF Bay paddling map.
