// Hand-placed labels: HTML markers positioned in lng/lat, styled with real
// web fonts (letter-spacing, italics, curves later), draggable in edit mode,
// saved to places/<place>/labels.json by serve.mjs.
//
// In 'paper' mode labels scale with the map like ink on a sheet; in 'web'
// mode they keep a constant on-screen size.

export const STYLES = {
  water:    { font: '"EB Garamond", Georgia, serif', italic: true, color: '#3f7fbf', weight: 500 },
  ocean:    { font: '"EB Garamond", Georgia, serif', italic: true, color: '#3f7fbf', weight: 500, caps: true, spacing: 0.32 },
  area:     { font: '"Source Sans 3", Helvetica, Arial, sans-serif', color: '#1f1f1f', weight: 500 },
  feature:  { font: '"Source Sans 3", Helvetica, Arial, sans-serif', color: '#1f1f1f', weight: 400 },
  town:     { font: '"Source Sans 3", Helvetica, Arial, sans-serif', color: '#8d918a', weight: 700, caps: true, spacing: 0.14 },
  locator:  { locator: true },
};

export class LabelLayer {
  constructor(map, { place, labels, mode, designZoom, onSelect, onSave, onDirty }) {
    Object.assign(this, { map, place, labels, mode, designZoom, onSelect, onSave, onDirty });
    this.markers = [];
    this.editing = false;
    this.render();
    map.on('zoom', () => this.rescale());
  }

  render() {
    this.markers.forEach(m => m.remove());
    this.markers = this.labels.map((l, i) => {
      const el = document.createElement('div');
      el.className = 'hand-label';
      el.dataset.i = i;
      this.paint(el, l);
      el.addEventListener('mousedown', () => this.editing && this.select(i));
      const m = new window.maplibregl.Marker({ element: el, draggable: this.editing, rotationAlignment: 'map', pitchAlignment: 'map' })
        .setLngLat(l.at).setRotation(l.rotate || 0).addTo(this.map);
      m.on('dragend', () => { const p = m.getLngLat(); l.at = [+p.lng.toFixed(5), +p.lat.toFixed(5)]; this.dirty(); });
      return m;
    });
    this.rescale();
  }

  paint(el, l) {
    const s = STYLES[l.style] || STYLES.feature;
    el.innerHTML = '';
    el.classList.toggle('locator', !!s.locator);
    if (s.locator) { el.textContent = l.text; return; }
    el.style.fontFamily = s.font;
    el.style.fontStyle = s.italic ? 'italic' : 'normal';
    el.style.fontWeight = s.weight;
    el.style.color = s.color;
    el.style.letterSpacing = `${l.spacing ?? s.spacing ?? 0}em`;
    el.style.textTransform = s.caps ? 'uppercase' : 'none';
    el.style.whiteSpace = 'pre';
    el.style.textAlign = 'center';
    el.style.lineHeight = '1.05';
    el.textContent = l.text;
  }

  rescale() {
    const k = this.mode === 'paper' ? 2 ** (this.map.getZoom() - this.designZoom) : 1;
    this.markers.forEach((m, i) => {
      const l = this.labels[i];
      const el = m.getElement();
      el.style.fontSize = `${(l.size || 13) * k}px`;
      if (el.classList.contains('locator')) { el.style.width = el.style.height = `${(l.size || 13) * 1.7 * k}px`; }
      // in web mode, small labels bow out at low zoom unless they're big names
      const hide = this.mode === 'web' && l.minzoom && this.map.getZoom() < l.minzoom;
      el.style.visibility = hide ? 'hidden' : 'visible';
    });
  }

  setMode(mode) { this.mode = mode; this.rescale(); }

  setEditing(on) {
    this.editing = on;
    this.markers.forEach(m => m.setDraggable(on));
    document.body.classList.toggle('editing', on);
    if (!on) this.select(null);
  }

  select(i) {
    this.selected = i;
    this.markers.forEach((m, j) => m.getElement().classList.toggle('selected', j === i));
    this.onSelect?.(i == null ? null : this.labels[i], i);
  }

  update(i, patch) {
    Object.assign(this.labels[i], patch);
    const m = this.markers[i];
    this.paint(m.getElement(), this.labels[i]);
    m.setRotation(this.labels[i].rotate || 0);
    this.rescale();
    this.dirty();
  }

  add(at, props = {}) {
    this.labels.push({ text: 'New label', style: 'feature', size: 13, ...props, at });
    this.render();
    this.select(this.labels.length - 1);
    this.dirty();
  }

  remove(i) { this.labels.splice(i, 1); this.render(); this.select(null); this.dirty(); }

  dirty() {
    this.onDirty?.();
    clearTimeout(this.t);
    this.t = setTimeout(() => this.save(), 400);
  }

  async save() {
    const body = JSON.stringify(this.labels, null, 1);
    const r = await fetch(`places/${this.place}/labels.json`, { method: 'PUT', body });
    this.onSave?.(r.ok);
  }
}
