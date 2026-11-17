// Tiny dev server: serves the project folder and lets the label editor
// save hand-placed labels back to places/<place>/labels.json.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
const port = Number(process.env.PORT || 5190);
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.geojson': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.map': 'application/json', '.pmtiles': 'application/octet-stream',
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root)) return res.writeHead(403).end();

  // PUT /places/<place>/labels.json — save from the label editor
  if (req.method === 'PUT') {
    if (!/^\/places\/[\w-]+\/labels\.json$/.test(url.pathname)) return res.writeHead(403).end();
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try { JSON.parse(body); } catch { return res.writeHead(400).end('bad json'); }
      fs.writeFileSync(file, body);
      res.writeHead(204).end();
    });
    return;
  }

  let p = file;
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) return res.writeHead(404).end('not found');
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
}).listen(port, () => console.log(`trail-cartography on http://localhost:${port}`));
