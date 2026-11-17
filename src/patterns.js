// Fill patterns and icons drawn on a canvas, so the style needs no sprite sheet.
const R = 2; // pixel ratio

function canvas(w, h, draw) {
  const el = document.createElement('canvas');
  el.width = w * R; el.height = h * R;
  const ctx = el.getContext('2d');
  ctx.scale(R, R);
  draw(ctx);
  return { width: el.width, height: el.height, data: new Uint8Array(ctx.getImageData(0, 0, el.width, el.height).data.buffer) };
}

export function addImages(map, c) {
  // salt-marsh tufts: little three-stroke fans, staggered
  map.addImage('marsh', canvas(28, 18, ctx => {
    ctx.strokeStyle = c.marsh; ctx.lineWidth = 0.6; ctx.lineCap = 'round';
    for (const [x, y] of [[6, 7], [20, 16]]) {
      ctx.beginPath(); ctx.moveTo(x - 3, y); ctx.lineTo(x + 3, y); ctx.stroke();
      for (const dx of [-1.6, 0, 1.6]) { ctx.beginPath(); ctx.moveTo(x + dx * 0.4, y - 0.4); ctx.lineTo(x + dx, y - 3); ctx.stroke(); }
    }
  }), { pixelRatio: R });

  // beach stipple: offset dots
  map.addImage('stipple', canvas(8, 8, ctx => {
    ctx.fillStyle = c.beachDot;
    for (const [x, y] of [[2, 2], [6, 6]]) { ctx.beginPath(); ctx.arc(x, y, 0.65, 0, Math.PI * 2); ctx.fill(); }
  }), { pixelRatio: R });

  // launch: dark green disc with a little kayak and paddle
  map.addImage('kayak', canvas(36, 36, ctx => {
    ctx.fillStyle = '#366f53'; ctx.beginPath(); ctx.arc(18, 18, 16, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6; ctx.fillStyle = '#fff';
    ctx.save(); ctx.translate(18, 18); ctx.rotate(-0.5);
    ctx.beginPath(); ctx.ellipse(0, 0, 11, 3.2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.rotate(1.2); ctx.beginPath(); ctx.moveTo(-11, 0); ctx.lineTo(11, 0); ctx.stroke();
    for (const x of [-11, 11]) { ctx.beginPath(); ctx.ellipse(x, 0, 2.6, 1.4, 0, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }), { pixelRatio: R });

  // trailhead parking: black rounded square, white P
  map.addImage('parking', canvas(36, 36, ctx => {
    ctx.fillStyle = '#111';
    ctx.beginPath(); ctx.roundRect(2, 2, 32, 32, 6); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 25px Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('P', 18, 19.5);
  }), { pixelRatio: R });
}
