// Colors sampled from the ECTA Ipswich Trails Guide (6th ed., 2023,
// mapping by the Center for Community GIS). Kept as one object so a
// place can override any of them.
export const ipswich = {
  paper: '#fbfaf6',        // private / developed land: near-white
  openSpace: '#d1d9ca',    // protected open space: soft sage
  outside: '#dde1d8',      // neighbouring towns: grey-green wash over everything
  outsideOpacity: 0.78,
  water: '#cee6eb',
  waterLine: '#6ea7c8',
  waterLabel: '#3f7fbf',
  stream: '#5b9bd0',
  marsh: '#4f93c6',
  contour: '#c9ab84',
  contourIndex: '#b8946a',
  trail: '#b8414a',
  trailOutside: '#d9a3a3',
  road: '#2b2b2b',
  street: '#5c5c5c',
  service: '#8a8a8a',
  building: '#b9b6ab',
  cliff: '#8c7b68',
  beachDot: '#2a2a2a',
  boundary: '#1f1f1f',
  locator: '#366f53',
  ink: '#1f1f1f',
  inkSoft: '#5a5a5a',
  townLabel: '#8d918a',
  title: '#9b2f35',
};

// National Park Service brochure look (sampled from the NPS Marin Headlands map, rev. 04/22):
// grey-green park land, neutral grey outside, pale blue water, black trails coded by use,
// white cased roads, dark red highways, strong grey relief and no contours.
export const nps = {
  ...ipswich,
  paper: '#ececeb',        // land outside the park: neutral light grey
  openSpace: '#c3cec7',    // park land: grey-green
  outside: '#f4f4f3',      // a light wash only: the park / non-park fill difference does the work
  outsideOpacity: 0.35,
  water: '#e6f1f5',
  waterLine: '#8fb9cc',
  waterLabel: '#4b86ad',
  stream: '#8fb9cc',
  trail: '#1b1b1b',
  road: '#2b2b2b',         // road casing
  roadFill: '#ffffff',
  highway: '#9a3b2e',
  street: '#2b2b2b',
  service: '#6b6b6b',
  building: '#b5b5b2',
  boundary: '#6b766f',
  ink: '#1b1b1b',
  inkSoft: '#5f5f5f',
  peak: '#6b6b6b',
};
// Vegetation: the painterly land cover is the base; trails and roads must read on green and brown
export const vegStyle = {
  ...ipswich,
  trail: '#2d221c', trailCasing: '#fbf6ea',
  road: '#3a3a3a', roadFill: '#fbfaf6', highway: '#fbfaf6',
  boundary: '#3a3a3a', outside: '#e4e3dc', outsideOpacity: 0.7,
};
// towns pushed back: light grey streets, a faint grey on built-up land, open space a touch stronger
export const MUTED_TOWNS = {
  road: '#77746d', street: '#bdbab2', service: '#d6d3cb', building: '#dedbd3',
  developed: '#f0efea', openSpace: '#cbd6c3',
};

export const PALETTES = { ecta: ipswich, nps, veg: vegStyle };
export const PRESETS = [['ecta', 'ECTA trails guide'], ['nps', 'National Park'], ['veg', 'Vegetation (painted)']];
