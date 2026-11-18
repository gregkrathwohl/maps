// Tiny dev server: serves the project folder and lets the label editor
// save hand-placed labels back to places/<place>/labels.json.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.dirname(new URL(import.meta.url).pathname);
const port = Number(process.env.PORT || 5190);
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.geojson': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.map': 'application/json', '.pmtiles': 'application/octet-stream', '.webp': 'image/webp',
};

const BLENDER = process.env.BLENDER || '/Applications/Blender.app/Contents/MacOS/Blender';
const run = (cmd, args) => new Promise((ok, no) => {
  const p = spawn(cmd, args, { cwd: root });
  let log = '';
  p.stdout.on('data', d => { log += d; process.stdout.write(d); });
  p.stderr.on('data', d => { log += d; });
  p.on('error', no);
  p.on('close', code => (code === 0 ? ok(log) : no(new Error(`${path.basename(cmd)} exited ${code}: ${log.slice(-400)}`))));
});

const vegJobs = {};
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root)) return res.writeHead(403).end();

  // PUT /places/<place>/labels.json | trips.json — save from the label editor / route planner
  if (req.method === 'PUT') {
    if (!/^\/places\/[\w-]+\/(labels|trips)\.json$/.test(url.pathname)) return res.writeHead(403).end();
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try { JSON.parse(body); } catch { return res.writeHead(400).end('bad json'); }
      fs.writeFileSync(file, body);
      res.writeHead(204).end();
    });
    return;
  }

  // POST /api/relief/<place> {look?, bake?, quick?} — save the relief look to place.json and/or
  // re-render the Blender relief with new sun / exaggeration settings (dev only, takes minutes)
  const rm = req.method === 'POST' && url.pathname.match(/^\/api\/relief\/([\w-]+)$/);
  if (rm) {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      const fail = (e) => res.writeHead(500).end(String(e?.message || e));
      try {
        const { look, bake, quick } = JSON.parse(body || '{}');
        const place = rm[1], cfgFile = path.join(root, 'places', place, 'place.json');
        if (bake) {
          const n = (v) => String(Number(v));
          await run(BLENDER, ['-b', '--python', 'scripts/relief.py', '--', place,
            '--exag', n(bake.exag), '--sun-alt', n(bake.sunAlt), '--sun-az', n(bake.sunAz), '--sun-soft', n(bake.sunSoft),
            '--sky', n(bake.sky), '--sun-energy', n(bake.sunEnergy),
            ...(quick ? ['--step', '2', '--scale', '0.5', '--samples', '32'] : [])]);
          await run(path.join(root, '.venv/bin/python'), ['scripts/relief-web.py', place, '--bake', JSON.stringify(bake)]);
        }
        const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
        if (look) { cfg.relief.look = look; fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n'); }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ flat: cfg.relief.flat }));
      } catch (e) { fail(e); }
    });
    return;
  }

  // POST /api/settings/<place> {defaults} — the editor's autosave: merged into place.json
  const sm = req.method === 'POST' && url.pathname.match(/^\/api\/settings\/([\w-]+)$/);
  if (sm) {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const { defaults } = JSON.parse(body || '{}');
        const cfgFile = path.join(root, 'places', sm[1], 'place.json');
        const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
        if (defaults) cfg.defaults = { ...(cfg.defaults || {}), ...defaults };
        fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      } catch (e) { res.writeHead(500).end(String(e?.message || e)); }
    });
    return;
  }

  // POST /api/new {name, bbox, center, zoom} — a new draft place: place.json, then OSM via Overpass,
  // then the park boundaries that fill most of the frame (they drive the grey "outside" wash)
  if (req.method === 'POST' && url.pathname === '/api/new') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      try {
        const { name, bbox, center, zoom } = JSON.parse(body || '{}');
        if (!name || !Array.isArray(bbox) || bbox.length !== 4) throw new Error('name and bbox are required');
        const slug = name.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').slice(0, 40) || 'map';
        let id = slug, k = 2;
        while (fs.existsSync(path.join(root, 'places', id))) id = `${slug}-${k++}`;
        const dir = path.join(root, 'places', id);
        fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
        const cfg = { name, title: name, subtitle: 'Trails Guide', draft: true, created: new Date().toISOString().slice(0, 10),
          bbox, center, zoom, extent: 'bbox', areas: [], boundaries: [], defaults: { mode: 'paper', hillshade: true, contours: true, shade: { preset: 'google', method: 'combined', exaggeration: 0.85, direction: 315, altitude: 38, shadow: '#1e4436', highlight: '#e6fff1', highlightOpacity: 0.75, accent: '#2f5c4b', land: '#bfe5cf', contour: '#4f8a70', contourOpacity: 0.45 } } };
        const write = () => fs.writeFileSync(path.join(dir, 'place.json'), JSON.stringify(cfg, null, 2) + '\n');
        write();
        fs.writeFileSync(path.join(dir, 'labels.json'), '[]\n');
        try { await run('node', ['scripts/fetch-osm.mjs', id]); }
        catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
        // the extent is the framed rectangle for now; parks / custom shapes come later (scripts/parks.mjs)
        write();
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id, boundaries: cfg.boundaries }));
      } catch (e) { res.writeHead(500).end(String(e?.message || e)); }
    });
    return;
  }

  // /api/vegetation/<place>: POST starts scripts/vegetation.py in the background (NAIP download +
  // render, several minutes); GET reports progress {running, done, total, error}
  const vm = url.pathname.match(/^\/api\/vegetation\/([\w-]+)$/);
  if (vm) {
    const id = vm[1];
    const send = (o) => res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(o));
    if (req.method === 'POST') {
      if (vegJobs[id]?.running) return send(vegJobs[id]);
      const job = vegJobs[id] = { running: true, done: 0, total: 0, log: '', started: Date.now() };
      const p = spawn(path.join(root, '.venv/bin/python'), ['scripts/vegetation.py', id], { cwd: root });
      const read = (d) => {
        job.log = (job.log + d).slice(-4000);
        for (const m of String(d).matchAll(/(\d+) tiles|tile (\d+)\/(\d+) done/g)) {
          if (m[1]) job.total = +m[1]; else { job.done = +m[2]; job.total = +m[3]; }
        }
      };
      p.stdout.on('data', read); p.stderr.on('data', read);
      p.on('close', (code) => { job.running = false; if (code !== 0) job.error = job.log.slice(-400); });
      return send(job);
    }
    return send(vegJobs[id] || { running: false });
  }

  // GET /api/places — every places/<id>/place.json, for the library page
  if (url.pathname === '/api/places') {
    const dir = path.join(root, 'places');
    const list = fs.readdirSync(dir).filter(d => fs.existsSync(path.join(dir, d, 'place.json')))
      .map(id => ({ id, ...JSON.parse(fs.readFileSync(path.join(dir, id, 'place.json'), 'utf8')) }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(list));
  }

  let p = file;
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) return res.writeHead(404).end('not found');
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
}).listen(port, () => console.log(`trail-cartography on http://localhost:${port}`));
