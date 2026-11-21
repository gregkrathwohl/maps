# What's published vs still local

Greg's map projects at a glance. Update this file when something ships or moves.
Last updated 2026-11-20.

Local servers run all the time through **devhub** (`~/dev/devhub`): http://localhost:5100, or the `devhub` command.

## Two projects

| Project | Folder | Live | Local dev |
|---|---|---|---|
| Trail and paddling maps | `~/dev/trail-cartography` | https://gregkrathwohl.github.io/maps | http://localhost:5190 |
| SF Bay Currents | `~/dev/bay-paddling` | https://gregkrathwohl.github.io/bay-paddling | http://localhost:5191 |

How each one publishes:

- **trail-cartography:** run `scripts/deploy.sh`. A daily GitHub Action (Refresh currents) also rebuilds the site from `origin/main`. Anything not pushed to main disappears from the live site the next morning.
- **bay-paddling:** push main. The `publish.yml` Action builds the site, and it also runs on a schedule.

## Map by map

| Map | State | Notes |
|---|---|---|
| **SF Bay Currents** (bay-paddling, `sf-bay`) | Live, up to date (published 2026-11-20) | The most polished map: something to look at, not to label. It used to be a paddling guide; now it's only the currents: no route planner, no legend, no editor, a caption title, and the time and tide at the bottom left. |
| **Richardson Bay paddling guide** (trail-cartography, `richardson-bay`) | Live (older version) | Will become *the* paddling guide: routing, buoys, depth, subtler currents. |
| **Southern Marin trails** (trail-cartography, `southern-marin`) | Live, up to date (published 2026-11-20) | Pretty good already; the long job is labeling. Has PDF download, area and ridge labels, summit icons, dark through-roads, trail-access fixes, parking hidden. |
| **Angel Island** (trail-cartography, `angel-island`) | Live (older look). Greg's editor tweaks are local | First print candidate. Leaning toward the vegetation look: it's small, so print the fine detail. |
| **Marin Headlands** | Live | Greg may take it out of the library and keep it as a draft. |
| Mount Tamalpais, Ipswich, Angel Island painted | Local only | Experiments. Greg's place.json tweaks are unsaved, so ask before publishing them. |
| Painted-land Bay currents (`~/dev/bay-paddling-painted`, branch `painted-land`) | Local experiment | Not to be built out Bay-wide yet. |

## Library curation Greg wants (not done yet)

- Show Richardson Bay and SF Bay Currents publicly. Hide or draft the rest until they're ready.
- Keep the currents visualization separate from the paddling guide (done in the bay-paddling cleanup above).

## Uncommitted right now

- **trail-cartography:** main is pushed. Still uncommitted: Greg's editor tweaks to Angel Island, Angel Island painted, Ipswich, Mount Tamalpais (place.json) and the Richardson Bay labels. Ask before publishing them.
- **bay-paddling:** nothing; main is pushed.
