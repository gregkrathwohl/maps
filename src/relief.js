// Blender relief, drawn live: the grey render becomes transparent shadows (tinted) and white
// highlights in a canvas, so strength / contrast / tint can be tuned without re-rendering.
// Flat ground (the grey level of the sea in the render) is fully transparent.

export const LOOK = { shadow: 0.6, light: 0.5, gamma: 0.8, tint: '#3d4a3a', opacity: 0.9 };

export class Relief {
  static async load(url, flat) { const r = new Relief(); await r.reload(url, flat); return r; }

  // (re)read the grey render into the same canvas, so the map's canvas source keeps working
  async reload(url, flat) {
    const img = await createImageBitmap(await (await fetch(url, { cache: 'reload' })).blob());
    this.canvas ||= document.createElement('canvas');
    this.canvas.width = img.width; this.canvas.height = img.height;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, img.width, img.height).data;
    this.grey = new Uint8Array(img.width * img.height);
    for (let i = 0; i < this.grey.length; i++) this.grey[i] = px[i * 4];
    this.ctx = ctx; this.flat = flat;
  }

  paint(look) {
    const { shadow, light, gamma, tint } = { ...LOOK, ...look };
    const t = [1, 3, 5].map(i => parseInt(tint.slice(i, i + 2), 16));
    const f = this.flat;
    // one lookup table entry per grey level: 256 pow() calls instead of millions
    const lut = new Uint8ClampedArray(256 * 4);
    for (let g = 0; g < 256; g++) {
      const v = g / 255;
      const dark = v < f ? Math.pow((f - v) / f, gamma) * shadow : 0;
      const lite = v > f ? Math.pow((v - f) / (1 - f + 1e-6), gamma) * light : 0;
      const [r, gg, b] = dark > 0 ? t : [255, 255, 255];
      lut.set([r, gg, b, Math.round(Math.max(dark, lite) * 255)], g * 4);
    }
    const out = this.ctx.createImageData(this.canvas.width, this.canvas.height);
    const o = out.data, grey = this.grey;
    for (let i = 0, j = 0; i < grey.length; i++, j += 4) {
      const k = grey[i] * 4;
      o[j] = lut[k]; o[j + 1] = lut[k + 1]; o[j + 2] = lut[k + 2]; o[j + 3] = lut[k + 3];
    }
    this.ctx.putImageData(out, 0, 0);
  }
}

// a canvas source only re-uploads while "playing": play briefly after a repaint (a timer, not
// rAF, so it also works when the tab is in the background), then stop to save the GPU
let stopT = 0;
export function refresh(map) {
  const src = map.getSource('relief');
  if (!src?.play) return;
  src.play(); map.triggerRepaint();
  clearTimeout(stopT); stopT = setTimeout(() => src.pause(), 400);
}
