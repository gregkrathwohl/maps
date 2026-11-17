// Tide predictions (high/low) from NOAA CO-OPS for the place's tide station, covering
// the current-forecast window (plus a day either side so the curve has ends).
// usage: node scripts/fetch-tides.mjs <place>  → places/<place>/data/tides.json
import fs from 'node:fs';

const place = process.argv[2] || 'richardson-bay';
const cfg = JSON.parse(fs.readFileSync(`places/${place}/place.json`, 'utf8'));
if (!cfg.tides?.station) { console.log('no tides.station in place.json'); process.exit(0); }
const curPath = `places/${place}/data/currents-sfbofs.json`;
let from = new Date(Date.now() - 86400e3), to = new Date(Date.now() + 3 * 86400e3);
if (fs.existsSync(curPath)) {
  const t = JSON.parse(fs.readFileSync(curPath, 'utf8')).times;
  from = new Date(Date.parse(t[0]) - 86400e3); to = new Date(Date.parse(t[t.length - 1]) + 86400e3);
}
const ymd = (d) => d.toISOString().slice(0, 10).replaceAll('-', '');
const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=trail-cartography`
  + `&station=${cfg.tides.station}&begin_date=${ymd(from)}&end_date=${ymd(to)}&datum=MLLW&units=english&time_zone=gmt&interval=hilo&format=json`;
const j = await (await fetch(url)).json();
if (!j.predictions) throw new Error(JSON.stringify(j).slice(0, 300));
const hilo = j.predictions.map(p => ({ t: p.t.replace(' ', 'T') + ':00Z', v: +p.v, type: p.type }));
fs.writeFileSync(`places/${place}/data/tides.json`, JSON.stringify({ station: cfg.tides.station, name: cfg.tides.name, datum: 'MLLW', units: 'ft', hilo }));
console.log(`tides: ${hilo.length} highs/lows at ${cfg.tides.name} (${cfg.tides.station})`);
