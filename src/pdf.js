// "Download PDF": the whole sheet (place.json bbox) printed in paper mode at the map's native zoom (designZoom),
// exactly as it looks on screen at that zoom, but every part of it at once and at print resolution.
//
// The map is rendered in tiles by a hidden MapLibre map (one big canvas would blow past GPU limits), each tile
// with a margin around it so labels near a seam are placed the same way on both sides, then cropped. The HTML
// parts of the sheet (title, legend, hand-placed labels) are drawn on top through an SVG <foreignObject>, with
// their styles and web fonts inlined. The tiles go into the PDF as JPEGs; the page is sized so that one CSS px at
// the native zoom is 1/96 in, the same scale as a screen, so the PDF opens at "true size" and prints at any size.

const TILE = 1024, PAD = 256, Q = 0.92;

// ---- sheet geometry at the native zoom
export function sheetGeometry(bbox, z) {
  const world = 512 * 2 ** z;
  const X = (lng) => (lng + 180) / 360 * world;
  const Y = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2 * world;
  const [w, s, e, n] = bbox, x0 = X(w), y0 = Y(n);
  const lngOf = (x) => (x + x0) / world * 360 - 180;
  const latOf = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + y0) / world))) * 180 / Math.PI;
  return { W: Math.round(X(e) - x0), H: Math.round(Y(s) - y0), px: (lng, lat) => [X(lng) - x0, Y(lat) - y0], lngOf, latOf };
}

// ---- fonts: the page's Google Fonts CSS with each latin font file inlined as a data URL
let fontCSS;
async function inlineFonts() {
  if (fontCSS) return fontCSS;
  const link = [...document.querySelectorAll('link[rel=stylesheet]')].find(l => l.href.includes('fonts.googleapis'));
  if (!link) return (fontCSS = '');
  const css = await (await fetch(link.href)).text();
  const blocks = css.split('}').filter(b => b.includes('@font-face') && /U\+0000-00FF/.test(b));
  const out = [];
  for (const b of blocks) {
    const url = /url\(([^)]+)\)/.exec(b)?.[1];
    if (!url) continue;
    const buf = await (await fetch(url)).arrayBuffer();
    let bin = ''; const u8 = new Uint8Array(buf);
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    out.push(b.replace(url, `data:font/woff2;base64,${btoa(bin)}`) + '}');
  }
  return (fontCSS = out.join('\n'));
}

// ---- a live element, cloned with every computed style written inline (so it renders inside an SVG image)
const SKIP = new Set(['transform', 'transform-origin', 'translate', 'scale', 'rotate', 'position', 'left', 'top', 'right', 'bottom', 'inset']);
export function inlineClone(el) {
  const copy = el.cloneNode(false);
  if (el.nodeType === 3) return copy;
  if (el.nodeType !== 1) return document.createTextNode('');
  if (el.hidden || getComputedStyle(el).display === 'none') return document.createTextNode('');
  const cs = getComputedStyle(el);
  let st = '';
  for (const p of cs) if (!SKIP.has(p) && !p.startsWith('--') && !p.startsWith('transition') && !p.startsWith('animation')) st += `${p}:${cs.getPropertyValue(p)};`;
  for (const pseudo of ['::before', '::after']) {
    const ps = getComputedStyle(el, pseudo);
    if (ps.content && ps.content !== 'none' && ps.content !== 'normal') {
      // pseudo elements can't be inlined; turn them into real spans
      const span = document.createElement('span');
      let s2 = ''; for (const p of ps) if (!SKIP.has(p) && !p.startsWith('--')) s2 += `${p}:${ps.getPropertyValue(p)};`;
      span.setAttribute('style', s2);
      span.textContent = ps.content.replace(/^["']|["']$/g, '');
      copy.__pseudo = copy.__pseudo || {}; copy.__pseudo[pseudo] = span;
    }
  }
  copy.setAttribute('style', st);
  copy.removeAttribute('id'); copy.removeAttribute('class');
  if (copy.__pseudo?.['::before']) copy.appendChild(copy.__pseudo['::before']);
  for (const ch of el.childNodes) copy.appendChild(inlineClone(ch));
  if (copy.__pseudo?.['::after']) copy.appendChild(copy.__pseudo['::after']);
  return copy;
}
const xhtml = (node) => new XMLSerializer().serializeToString(node);

// ---- a minimal PDF writer: one page, JPEG tiles placed on it
function buildPDF(pageW, pageH, tiles) {   // pageW/H in points; tiles: { x, y, w, h (points, top-left origin), pxW, pxH, jpeg: Uint8Array }
  const enc = new TextEncoder(), parts = [], offsets = [];
  let size = 0;
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); size += b.length; };
  const obj = (n, body, stream) => {
    offsets[n] = size;
    push(`${n} 0 obj\n${body}\n`);
    if (stream) { push('stream\n'); push(stream); push('\nendstream\n'); }
    push('endobj\n');
  };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const first = 5, names = tiles.map((_, i) => `/T${i} ${first + i} 0 R`).join(' ');
  const content = tiles.map((t, i) => `q ${t.w.toFixed(3)} 0 0 ${t.h.toFixed(3)} ${t.x.toFixed(3)} ${(pageH - t.y - t.h).toFixed(3)} cm /T${i} Do Q`).join('\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW.toFixed(2)} ${pageH.toFixed(2)}] /Resources << /XObject << ${names} >> >> /Contents 4 0 R >>`);
  const cs = enc.encode(content);
  obj(4, `<< /Length ${cs.length} >>`, cs);
  tiles.forEach((t, i) => obj(first + i,
    `<< /Type /XObject /Subtype /Image /Width ${t.pxW} /Height ${t.pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${t.jpeg.length} >>`, t.jpeg));
  const n = first + tiles.length, xref = size;
  push(`xref\n0 ${n}\n0000000000 65535 f \n`);
  for (let i = 1; i < n; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

const idle = (m) => new Promise(r => m.once('idle', r));   // call right after jumpTo: fires once the new view is fully drawn
const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });

// opts: { style, bbox, designZoom, addImages(map), overlays(geom) -> [{ el, x, y, w?, transform? }], pixelRatio, onProgress, filename }
export async function exportPDF({ style, bbox, designZoom, addImages, overlays, pixelRatio, onProgress = () => {}, filename = 'map.pdf' }) {
  const g = sheetGeometry(bbox, designZoom);
  // density: about 7,200 px on the long side (300 dpi at 24 in) for small sheets, never less than 2x the screen
  const PR = pixelRatio ?? Math.min(4, Math.max(2, Math.round(7200 / Math.max(g.W, g.H))));
  onProgress('Preparing…');

  // the HTML layer for the whole sheet, positioned in sheet px
  const fonts = await inlineFonts();
  const items = overlays(g).map(o => `<div style="position:absolute;left:0;top:0;transform-origin:0 0;transform:${o.transform};${o.w ? `width:${o.w}px;` : ''}">${xhtml(o.el)}</div>`).join('');
  const overlayHTML = (x0, y0, w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w * PR}" height="${h * PR}" viewBox="${x0} ${y0} ${w} ${h}">
<foreignObject x="0" y="0" width="${g.W}" height="${g.H}"><div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${g.W}px;height:${g.H}px">
<style>${fonts}</style>${items}</div></foreignObject></svg>`;

  // the hidden map
  const box = document.createElement('div');
  const side = TILE + 2 * PAD;
  Object.assign(box.style, { position: 'fixed', left: '0', top: '0', width: `${side}px`, height: `${side}px`, opacity: '0', pointerEvents: 'none', zIndex: '-1' });
  document.body.appendChild(box);
  const m = new window.maplibregl.Map({
    container: box, style, center: [g.lngOf(g.W / 2), g.latOf(g.H / 2)], zoom: designZoom, interactive: false,
    pixelRatio: PR, fadeDuration: 0, attributionControl: false, maxCanvasSize: [8192, 8192],
    canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
  });
  m.on('styleimagemissing', () => {});
  m.on('style.load', () => addImages(m));
  await new Promise(r => m.once('load', r));

  const cols = Math.ceil(g.W / TILE), rows = Math.ceil(g.H / TILE), tiles = [];
  const cv = document.createElement('canvas'), ctx = cv.getContext('2d');
  try {
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      onProgress(`Rendering ${r * cols + c + 1} / ${rows * cols}`);
      const x0 = c * TILE, y0 = r * TILE, w = Math.min(TILE, g.W - x0), h = Math.min(TILE, g.H - y0);
      // centre the hidden map so this tile sits at (PAD, PAD) in its canvas
      m.jumpTo({ center: [g.lngOf(x0 - PAD + side / 2), g.latOf(y0 - PAD + side / 2)], zoom: designZoom });
      await idle(m);
      cv.width = Math.round(w * PR); cv.height = Math.round(h * PR);
      ctx.drawImage(m.getCanvas(), PAD * PR, PAD * PR, cv.width, cv.height, 0, 0, cv.width, cv.height);
      if (items) {
        const img = await loadImg(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(overlayHTML(x0, y0, w, h))}`);
        ctx.drawImage(img, 0, 0, cv.width, cv.height);
      }
      const blob = await new Promise(res => cv.toBlob(res, 'image/jpeg', Q));
      tiles.push({ x: x0 * 0.75, y: y0 * 0.75, w: w * 0.75, h: h * 0.75, pxW: cv.width, pxH: cv.height, jpeg: new Uint8Array(await blob.arrayBuffer()) });
    }
  } finally { m.remove(); box.remove(); }

  onProgress('Saving…');
  const pdf = buildPDF(g.W * 0.75, g.H * 0.75, tiles);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(pdf); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return { widthIn: g.W / 96, heightIn: g.H / 96, px: [Math.round(g.W * PR), Math.round(g.H * PR)], bytes: pdf.size };
}
