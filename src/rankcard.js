// Kartu gambar Rank Up (PNG) memakai @napi-rs/canvas.
// Kalau library/font gagal dimuat, fungsi mengembalikan null dan bot tetap jalan tanpa gambar.
const path = require('path');
const fs = require('fs');

let lib = null; // null = belum dicoba, false = gagal
const FONT = 'VDPFont';

function load() {
  if (lib !== null) return lib;
  try {
    lib = require('@napi-rs/canvas');
    const f = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans-Bold.ttf');
    if (fs.existsSync(f)) lib.GlobalFonts.registerFromPath(f, FONT);
  } catch (err) {
    console.warn('[rankcard] canvas tidak tersedia, gambar rank-up dilewati:', err.message);
    lib = false;
  }
  return lib;
}

function rgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (hex, a) => {
  const [r, g, b] = rgb(hex);
  return `rgba(${r},${g},${b},${a})`;
};

function hexagon(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI / 3) * i - Math.PI / 2;
    const x = cx + r * Math.cos(ang);
    const y = cy + r * Math.sin(ang);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/**
 * @param {{name:string, tier:{name:string,color:string}, division:string, fromMmr:number|null, toMmr:number, kind:'rankup'|'placement'}} o
 * @returns {Buffer|null} PNG
 */
function renderRankCard(o) {
  const L = load();
  if (!L) return null;
  try {
    const W = 900;
    const H = 420;
    const canvas = L.createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const col = o.tier.color;
    const font = (size) => `bold ${size}px ${FONT}, sans-serif`;

    // Latar
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#07070d');
    bg.addColorStop(1, '#14141f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Glow di belakang emblem
    const glow = ctx.createRadialGradient(W / 2, 150, 10, W / 2, 150, 260);
    glow.addColorStop(0, rgba(col, 0.55));
    glow.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // Garis diagonal dekoratif
    ctx.strokeStyle = rgba(col, 0.08);
    ctx.lineWidth = 2;
    for (let x = -H; x < W; x += 46) {
      ctx.beginPath();
      ctx.moveTo(x, H);
      ctx.lineTo(x + H, 0);
      ctx.stroke();
    }

    // Bingkai
    ctx.strokeStyle = rgba(col, 0.9);
    ctx.lineWidth = 4;
    ctx.strokeRect(14, 14, W - 28, H - 28);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    // Judul
    ctx.fillStyle = col;
    ctx.font = font(38);
    ctx.fillText(o.kind === 'placement' ? 'PLACEMENT COMPLETE' : 'RANK UP', W / 2, 70);

    // Emblem heksagon + huruf tier
    hexagon(ctx, W / 2, 150, 62);
    ctx.fillStyle = rgba(col, 0.25);
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 5;
    ctx.stroke();
    hexagon(ctx, W / 2, 150, 44);
    ctx.strokeStyle = rgba(col, 0.6);
    ctx.lineWidth = 2;
    ctx.stroke();
    const parts = o.tier.name.split(' ');
    const glyph = (parts.length > 1 ? parts.map((w) => w[0]).join('') : o.tier.name.slice(0, 2)).toUpperCase();
    ctx.fillStyle = '#ffffff';
    ctx.font = font(40);
    ctx.fillText(glyph, W / 2, 164);

    // Nama pemain
    const name = o.name.length > 22 ? o.name.slice(0, 21) + '…' : o.name;
    ctx.fillStyle = '#ffffff';
    ctx.font = font(36);
    ctx.fillText(name.toUpperCase(), W / 2, 266);

    // Rank
    ctx.fillStyle = col;
    ctx.font = font(60);
    ctx.fillText(`${o.tier.name.toUpperCase()}${o.division ? ' ' + o.division : ''}`, W / 2, 334);

    // MMR
    ctx.fillStyle = '#b8b8c8';
    ctx.font = font(26);
    const mmrText = o.fromMmr == null ? `${o.toMmr} MMR` : `${o.fromMmr}  >  ${o.toMmr} MMR`;
    ctx.fillText(mmrText, W / 2, 376);

    return canvas.toBuffer('image/png');
  } catch (err) {
    console.warn('[rankcard] gagal render:', err.message);
    return null;
  }
}

module.exports = { renderRankCard };
