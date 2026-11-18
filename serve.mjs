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
  '.map': 'application/json', '.pmtiles': 'application/octet-stream',
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
        if (look) { cfg.relief.look = look; fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 1) + '\n'); }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ flat: cfg.relief.flat }));
      } catch (e) { fail(e); }
    });
    return;
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
