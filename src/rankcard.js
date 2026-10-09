// Kartu gambar Rank Up (PNG) memakai @napi-rs/canvas.
// Emblem tier diambil dari assets/emblems/<nama-tier>.png (mis. rookie.png, apex-predator.png).
// Kalau library/font/emblem gagal dimuat, kartu tetap dibuat dengan emblem heksagon sederhana,
// dan kalau library canvas sendiri gagal, fungsi mengembalikan null (bot tetap jalan tanpa gambar).
const path = require('path');
const fs = require('fs');

let lib = null; // null = belum dicoba, false = gagal
const FONT = 'VDPFont';
const EMBLEM_DIR = path.join(__dirname, '..', 'assets', 'emblems');
const emblemCache = new Map(); // slug -> Image

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

const slugOf = (tierName) => tierName.toLowerCase().replace(/\s+/g, '-');

// Muat semua emblem sekali di awal (async), lalu dipakai dari cache saat render.
// Kalau render terjadi sebelum selesai dimuat, kartu memakai emblem heksagon cadangan.
function preloadEmblems(L) {
  let files = [];
  try {
    files = fs.readdirSync(EMBLEM_DIR).filter((f) => f.endsWith('.png'));
  } catch (err) {
    console.warn(`[rankcard] folder emblem tidak ditemukan (${EMBLEM_DIR}), pakai emblem cadangan`);
    return;
  }
  for (const f of files) {
    L.loadImage(path.join(EMBLEM_DIR, f))
      .then((img) => emblemCache.set(f.replace(/\.png$/, ''), img))
      .catch((err) => console.warn(`[rankcard] gagal memuat emblem ${f}:`, err.message));
  }
}

const getEmblem = (tierName) => emblemCache.get(slugOf(tierName)) || null;

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

// Emblem cadangan (heksagon + 2 huruf) kalau file gambar emblem tidak ada
function drawFallbackEmblem(ctx, font, o, cx, cy) {
  const col = o.tier.color;
  hexagon(ctx, cx, cy, 70);
  ctx.fillStyle = rgba(col, 0.25);
  ctx.fill();
  ctx.strokeStyle = col;
  ctx.lineWidth = 5;
  ctx.stroke();
  hexagon(ctx, cx, cy, 50);
  ctx.strokeStyle = rgba(col, 0.6);
  ctx.lineWidth = 2;
  ctx.stroke();

  const parts = o.tier.name.split(' ');
  const glyph = (parts.length > 1 ? parts.map((w) => w[0]).join('') : o.tier.name.slice(0, 2)).toUpperCase();
  ctx.fillStyle = '#ffffff';
  ctx.font = font(44);
  ctx.textAlign = 'center';
  ctx.fillText(glyph, cx, cy + 16);
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
    const H = 500;
    const EMBLEM_CY = 190;
    const EMBLEM_SIZE = 230;
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
    const glow = ctx.createRadialGradient(W / 2, EMBLEM_CY, 10, W / 2, EMBLEM_CY, 290);
    glow.addColorStop(0, rgba(col, 0.5));
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
    ctx.fillText(o.kind === 'placement' ? 'PLACEMENT COMPLETE' : 'RANK UP', W / 2, 62);

    // Emblem tier
    const emblem = getEmblem(o.tier.name);
    if (emblem) {
      ctx.drawImage(emblem, W / 2 - EMBLEM_SIZE / 2, EMBLEM_CY - EMBLEM_SIZE / 2, EMBLEM_SIZE, EMBLEM_SIZE);
    } else {
      drawFallbackEmblem(ctx, font, o, W / 2, EMBLEM_CY);
    }

    // Nama pemain
    ctx.textAlign = 'center';
    const name = o.name.length > 22 ? o.name.slice(0, 21) + '…' : o.name;
    ctx.fillStyle = '#ffffff';
    ctx.font = font(36);
    ctx.fillText(name.toUpperCase(), W / 2, 346);

    // Rank
    ctx.fillStyle = col;
    ctx.font = font(60);
    ctx.fillText(`${o.tier.name.toUpperCase()}${o.division ? ' ' + o.division : ''}`, W / 2, 414);

    // MMR
    ctx.fillStyle = '#b8b8c8';
    ctx.font = font(26);
    const mmrText = o.fromMmr == null ? `${o.toMmr} MMR` : `${o.fromMmr}  >  ${o.toMmr} MMR`;
    ctx.fillText(mmrText, W / 2, 458);

    return canvas.toBuffer('image/png');
  } catch (err) {
    console.warn('[rankcard] gagal render:', err.message);
    return null;
  }
}

// Mulai memuat emblem begitu modul di-require (saat bot start)
const L0 = load();
if (L0) preloadEmblems(L0);

module.exports = { renderRankCard };
