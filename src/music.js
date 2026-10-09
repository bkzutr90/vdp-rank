// Fitur musik (mirip Jockie Music) memakai DisTube.
// Engine utama: @distube/youtube (native, tanpa spawn proses => cepat). Cadangan: yt-dlp.
// Ganti engine lewat env var MUSIC_ENGINE=ytdlp (kembali ke setup lama) tanpa ubah kode.
// Mode 24/7: bot TIDAK keluar saat voice kosong / queue habis / stop. Satu-satunya cara keluar: /leave.
// Channel voice terakhir disimpan di tabel settings, jadi bot masuk lagi otomatis setelah restart / ke-disconnect.
// FFmpeg: memakai ffmpeg sistem (PATH). ffmpeg-static dibuang karena crash SIGSEGV di container Railway.
//
// Env opsional:
//   MUSIC_ENGINE=ytdlp          -> paksa engine yt-dlp
//   YTDLP_REMOTE_COMPONENTS=1   -> yt-dlp mengunduh komponen JS challenge (ejs) dari GitHub tiap panggilan.
//                                  Hanya nyalakan kalau yt-dlp kamu butuh dan koneksi ke GitHub lancar.
//   PLAY_TIMEOUT_MS=45000       -> batas waktu /play sebelum dibatalkan
//   MIX_LIMIT=25                -> jumlah lagu yang diambil dari link YouTube Mix (list=RD...)
//   YTDLP_PROXY=0               -> matikan proxy stream lokal (kembali ke ffmpeg langsung ke URL googlevideo)
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile, spawn } = require('child_process');
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { DisTube } = require('distube');
const { YtDlpPlugin } = require('@distube/yt-dlp');
const { generateDependencyReport } = require('@discordjs/voice');
const { db } = require('./db');

// Plugin YouTube native: dimuat aman, kalau belum di-install bot tetap jalan dengan yt-dlp
let YouTubePlugin = null;
try {
  ({ YouTubePlugin } = require('@distube/youtube'));
} catch {
  console.warn('[music] @distube/youtube belum terpasang, pakai yt-dlp saja (npm install @distube/youtube)');
}

const EPHEMERAL = MessageFlags.Ephemeral;
const NO_PING = { parse: [] };
const KEY = 'music_vc';
const PLAY_TIMEOUT_MS = Number(process.env.PLAY_TIMEOUT_MS) || 45000;
const REMOTE_COMPONENTS = process.env.YTDLP_REMOTE_COMPONENTS === '1';
const MIX_LIMIT = Number(process.env.MIX_LIMIT) || 25; // maksimal lagu yang diambil dari YouTube Mix

// 'native' (default) atau 'ytdlp'
const USE_NATIVE = YouTubePlugin && (process.env.MUSIC_ENGINE || 'native').toLowerCase() !== 'ytdlp';

let distube = null;

// Lokasi binary yt-dlp bawaan @distube/yt-dlp (src/music.js -> ../node_modules/...)
const YTDLP = path.join(__dirname, '..', 'node_modules', '@distube', 'yt-dlp', 'bin', 'yt-dlp');

// ------------------------------------------------------------------ util
// Batasi waktu sebuah promise supaya bot tidak "thinking" selamanya.
const withTimeout = (p, ms, msg = 'YouTube terlalu lama merespons') =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout: ${msg}`)), ms))]);

// Buang parameter YouTube Mix (list=RD...) supaya tidak me-resolve playlist tak terbatas.
// Playlist asli (list=PL...) tetap dibiarkan.
function cleanUrl(input) {
  try {
    const u = new URL(input);
    const list = u.searchParams.get('list') || '';
    if (u.searchParams.get('v') && list.startsWith('RD')) {
      u.searchParams.delete('list');
      u.searchParams.delete('start_radio');
      u.searchParams.delete('index');
      return u.toString();
    }
  } catch {
    // bukan URL, biarkan apa adanya
  }
  return input;
}

// @distube/yt-dlp masih mengirim opsi lama --no-call-home. yt-dlp terbaru mencetak "Deprecated Feature"
// sehingga JSON.parse di plugin error dan bot crash. Solusi: bungkus binary dengan skrip yang membuang opsi itu.
// Wrapper juga menambahkan JS runtime (node, pasti ada di container) supaya yt-dlp bisa menyelesaikan
// challenge YouTube; tanpa itu URL stream kena throttle lalu putus.
// Aman dijalankan berulang (idempotent), dipanggil tiap bot start.
function patchYtDlp() {
  try {
    const dir = path.dirname(YTDLP);
    const real = path.join(dir, 'yt-dlp.real');
    if (!fs.existsSync(YTDLP)) return;

    const extraFlags = [`--js-runtimes node:${process.execPath}`];
    if (REMOTE_COMPONENTS) extraFlags.push('--remote-components ejs:github');

    const wrapper = [
      '#!/bin/sh',
      'real="$(dirname "$0")/yt-dlp.real"',
      'for a in "$@"; do',
      '  shift',
      '  if [ "$a" != "--no-call-home" ]; then set -- "$@" "$a"; fi',
      'done',
      `exec "$real" ${extraFlags.join(' ')} "$@"`,
      '',
    ].join('\n');

    const isWrapper = fs.statSync(YTDLP).size < 4096; // binary asli berukuran MB
    if (!isWrapper) fs.copyFileSync(YTDLP, real); // simpan binary asli
    if (!fs.existsSync(real)) return;

    // Tulis ulang hanya kalau isi wrapper berbeda (aman dipanggil tiap start)
    if (isWrapper && fs.readFileSync(YTDLP, 'utf8') === wrapper) return;

    fs.writeFileSync(YTDLP, wrapper);
    fs.chmodSync(YTDLP, 0o755);
    fs.chmodSync(real, 0o755);
    console.log(`[music] yt-dlp dipatch (--no-call-home dibuang, JS runtime node aktif${REMOTE_COMPONENTS ? ', remote components ON' : ''})`);
  } catch (err) {
    console.warn('[music] gagal patch yt-dlp:', err.message);
  }
}

// Cari lagu di YouTube lewat yt-dlp langsung, kembalikan URL video pertama.
// Hanya dipakai di mode MUSIC_ENGINE=ytdlp (mode native mencari sendiri lewat plugin).
function searchYoutube(query) {
  return new Promise((resolve, reject) => {
    execFile(
      YTDLP,
      [`ytsearch1:${query}`, '--flat-playlist', '--no-warnings', '--print', 'id'],
      { timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) {
          console.error('[music] yt-dlp search stderr:', stderr);
          return reject(new Error((stderr || err.message).trim().split('\n').pop()));
        }
        const id = stdout.trim().split('\n')[0];
        if (!id) return reject(new Error('Tidak ada hasil pencarian'));
        resolve(`https://www.youtube.com/watch?v=${id}`);
      }
    );
  });
}

// ------------------------------------------------------------------ proxy stream lokal (anti putus / throttle)
// Masalah: ffmpeg membuka URL googlevideo langsung dengan SATU request panjang. YouTube men-throttle lalu memutus
// request seperti itu (log: speed turun ke 1x, lalu "Premature close"), terutama untuk file besar (lagu panjang).
// Solusi: yt-dlp yang mengunduh (ia memakai request berpotongan/chunked + retry, jadi tidak diputus), hasilnya
// dialirkan lewat server HTTP lokal 127.0.0.1 ke ffmpeg. Hanya dipakai di engine yt-dlp.
const YT_ID = /^[\w-]{11}$/;
const ytIdFromUrl = (url) => {
  try {
    const u = new URL(url);
    const id = u.hostname === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v');
    return id && YT_ID.test(id) ? id : null;
  } catch {
    return null;
  }
};

let proxyPort = 0;
function startStreamProxy() {
  if (process.env.YTDLP_PROXY === '0') return;
  const server = http.createServer((req, res) => {
    const m = /^\/s\/([\w-]{11})$/.exec(req.url || '');
    if (!m) {
      res.writeHead(404);
      return res.end();
    }
    const id = m[1];
    const child = spawn(
      YTDLP,
      ['-f', 'bestaudio[ext=webm]/bestaudio', '--no-playlist', '--no-warnings', '--quiet', '--retries', '10', '-o', '-', `https://www.youtube.com/watch?v=${id}`],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    console.log(`[music] proxy: mulai stream ${id}`);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    child.stdout.pipe(res);
    child.stderr.on('data', (d) => console.warn('[music] proxy yt-dlp:', String(d).trim().slice(0, 300)));
    child.on('error', (err) => {
      console.error('[music] proxy spawn gagal:', err.message);
      res.destroy();
    });
    child.on('close', (code) => {
      console.log(`[music] proxy: yt-dlp selesai ${id} (code=${code})`);
      res.end();
    });
    res.on('close', () => child.kill('SIGKILL')); // ffmpeg berhenti / skip -> hentikan unduhan
  });
  server.on('error', (err) => console.warn('[music] proxy gagal start:', err.message));
  server.listen(0, '127.0.0.1', () => {
    proxyPort = server.address().port;
    console.log(`[music] proxy stream aktif di 127.0.0.1:${proxyPort}`);
  });
  server.unref();
}

// Plugin yt-dlp yang mengarahkan stream YouTube lewat proxy lokal di atas.
class ProxyYtDlpPlugin extends YtDlpPlugin {
  async getStreamURL(song) {
    const id = ytIdFromUrl(song.url);
    if (id && proxyPort) return `http://127.0.0.1:${proxyPort}/s/${id}`;
    return super.getStreamURL(song);
  }
}

// ------------------------------------------------------------------ YouTube Mix (list=RD...)
const isMixUrl = (input) => {
  try {
    const u = new URL(input);
    return !!u.searchParams.get('v') && (u.searchParams.get('list') || '').startsWith('RD');
  } catch {
    return false;
  }
};

// Ambil daftar id video dari Mix lewat yt-dlp (flat, dibatasi MIX_LIMIT supaya tidak tak terbatas).
function fetchMixIds(url, limit = MIX_LIMIT) {
  return new Promise((resolve, reject) => {
    execFile(
      YTDLP,
      ['--flat-playlist', '--playlist-end', String(limit), '--no-warnings', '--print', 'id', url],
      { timeout: 40000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim().split('\n').pop()));
        const ids = [...new Set(stdout.split('\n').map((x) => x.trim()).filter((x) => YT_ID.test(x)))];
        resolve(ids);
      }
    );
  });
}

// Guild yang sedang memuat Mix: pesan "masuk queue" per lagu disembunyikan (diganti 1 ringkasan).
const quietGuilds = new Set();

// ------------------------------------------------------------------ simpan channel 24/7
const getSaved = () => db.prepare('SELECT value FROM settings WHERE key=?').get(KEY)?.value || null;
const setSaved = (id) =>
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY, String(id));
const clearSaved = () => db.prepare('DELETE FROM settings WHERE key=?').run(KEY);

// ------------------------------------------------------------------ init
// Catat kapan lagu mulai diputar per guild, untuk mendeteksi stream yang putus sebelum waktunya.
const playStartedAt = new Map();

function initMusic(client) {
  // Cek versi library voice (boleh dihapus kalau sudah tidak perlu)
  console.log(generateDependencyReport());

  patchYtDlp(); // harus sebelum DisTube dibuat (yt-dlp tetap jadi cadangan / untuk situs selain YouTube)
  startStreamProxy();

  // Urutan plugin penting: plugin pertama yang cocok dengan input yang dipakai.
  const plugins = USE_NATIVE ? [new YouTubePlugin(), new ProxyYtDlpPlugin({ update: false })] : [new ProxyYtDlpPlugin({ update: false })];
  console.log(`[music] engine: ${USE_NATIVE ? 'native (@distube/youtube) + yt-dlp cadangan' : 'yt-dlp'}`);

  distube = new DisTube(client, {
    plugins,
    emitNewSongOnly: true,
    savePreviousSongs: true,
    joinNewVoiceChannel: true,
    // DisTube v5 tidak punya auto-leave, jadi bot memang tidak keluar sendiri (24/7).
    // FFmpeg diambil dari PATH sistem.
  });

  // Log debug DisTube (boleh dihapus kalau sudah normal)
  distube.on('debug', (msg) => console.log('[distube debug]', msg));
  distube.on('ffmpegDebug', (msg) => console.log('[ffmpeg]', String(msg).slice(0, 300)));

  distube.on('initQueue', (queue) => {
    queue.volume = 100;
  });

  distube
    .on('playSong', (queue, song) => {
      playStartedAt.set(queue.id, { t: Date.now(), duration: song.duration, live: song.isLive });
      const e = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('🎶 Sedang diputar')
        .setDescription(`**[${song.name}](${song.url})**`)
        .addFields(
          { name: 'Durasi', value: song.formattedDuration || 'Live', inline: true },
          { name: 'Diminta oleh', value: `${song.user}`, inline: true },
          { name: 'Volume', value: `${queue.volume}%`, inline: true }
        );
      if (song.thumbnail) e.setThumbnail(song.thumbnail);
      queue.textChannel?.send({ embeds: [e], allowedMentions: NO_PING }).catch(() => {});
    })
    .on('addSong', (queue, song) => {
      if (quietGuilds.has(queue.id)) return;
      queue.textChannel
        ?.send({ content: `➕ **${song.name}** (${song.formattedDuration}) masuk queue — oleh ${song.user}`, allowedMentions: NO_PING })
        .catch(() => {});
    })
    .on('addList', (queue, playlist) => {
      queue.textChannel
        ?.send({ content: `📃 Playlist **${playlist.name}** (${playlist.songs.length} lagu) masuk queue.`, allowedMentions: NO_PING })
        .catch(() => {});
    })
    .on('finish', (queue) => {
      // Diagnosa: kalau lagu selesai jauh lebih cepat dari durasinya, berarti stream putus (bukan selesai normal).
      const info = playStartedAt.get(queue.id);
      playStartedAt.delete(queue.id);
      if (info?.duration && !info.live) {
        const elapsed = Math.round((Date.now() - info.t) / 1000);
        const tag = elapsed < info.duration * 0.9 ? 'KEMUNGKINAN STREAM PUTUS' : 'selesai normal';
        console.log(`[music] finish: diputar ${elapsed}s dari ${info.duration}s -> ${tag}`);
      } else {
        console.log('[music] queue selesai');
      }
    })
    .on('error', (err, queue) => {
      console.error('[music] error:', err);
      queue?.textChannel?.send(`❌ Gagal memutar: \`${String(err.message || err).slice(0, 200)}\``).catch(() => {});
    });

  // Backstop 24/7: kalau bot ke-disconnect, masuk lagi. Kalau dipindah admin, ikuti channel barunya.
  client.on('voiceStateUpdate', (oldS, newS) => {
    if (newS.member?.id !== client.user.id) return;
    if (newS.channelId) {
      if (getSaved() && newS.channelId !== getSaved()) setSaved(newS.channelId);
      return;
    }
    if (getSaved()) setTimeout(() => restoreMusic(client), 5000);
  });
}

// Dipanggil saat bot ready: masuk lagi ke channel voice terakhir
async function restoreMusic(client) {
  const id = getSaved();
  if (!id || !distube) return;
  try {
    const ch = await client.channels.fetch(id);
    if (!ch || !ch.isVoiceBased()) return clearSaved();
    if (distube.voices.get(ch.guild.id)) return; // sudah terhubung
    await distube.voices.join(ch);
    console.log(`🎧 24/7: masuk ke voice #${ch.name}`);
  } catch (err) {
    console.warn('[music] gagal masuk ulang voice:', err.message);
  }
}

// ------------------------------------------------------------------ helper command
const list = [];
const def = (data, execute) => list.push({ data, execute });

const queueOf = (i) => distube.getQueue(i.guildId);
const userVoice = (i) => i.member?.voice?.channel || null;

// Pastikan user ada di voice & (kalau bot sedang main) di channel yang sama. Mengembalikan queue atau null (sudah membalas).
async function needQueue(i) {
  const q = queueOf(i);
  if (!q) {
    await i.reply({ content: '❌ Tidak ada lagu yang sedang diputar.', flags: EPHEMERAL });
    return null;
  }
  const vc = userVoice(i);
  if (!vc || vc.id !== q.voiceChannel?.id) {
    await i.reply({ content: '❌ Kamu harus berada di voice channel yang sama dengan bot.', flags: EPHEMERAL });
    return null;
  }
  return q;
}

// Muat sisa lagu Mix satu per satu di background (berhenti kalau queue sudah dihentikan).
async function loadMixRest(vc, urls, opts, guildId) {
  quietGuilds.add(guildId);
  let added = 0;
  try {
    for (const url of urls) {
      if (!distube.getQueue(guildId)) break; // /stop atau /leave dipanggil
      try {
        await withTimeout(distube.play(vc, url, opts), PLAY_TIMEOUT_MS);
        added++;
      } catch (err) {
        console.warn('[music] lagu Mix dilewati:', String(err.message || err).slice(0, 150));
      }
    }
  } finally {
    quietGuilds.delete(guildId);
  }
  opts.textChannel?.send({ content: `📃 Mix selesai dimuat: **${added + 1}** lagu masuk queue.`, allowedMentions: NO_PING }).catch(() => {});
}

// ------------------------------------------------------------------ /play
def(
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Putar lagu dari YouTube (judul / link / playlist)')
    .addStringOption((o) => o.setName('query').setDescription('Judul lagu atau link').setRequired(true)),
  async (i) => {
    const vc = userVoice(i);
    if (!vc) return i.reply({ content: '❌ Masuk ke voice channel dulu.', flags: EPHEMERAL });
    await i.deferReply();
    const query = i.options.getString('query', true).trim();
    try {
      const opts = { member: i.member, textChannel: i.channel };

      // Link YouTube Mix (list=RD...): ambil daftar lagunya, putar yang pertama dulu, sisanya dimuat di background.
      if (isMixUrl(query)) {
        let ids = [];
        try {
          ids = await fetchMixIds(query);
        } catch (err) {
          console.warn('[music] gagal ambil Mix, putar satu lagu saja:', err.message);
        }
        if (ids.length > 1) {
          const watch = (id) => `https://www.youtube.com/watch?v=${id}`;
          await withTimeout(distube.play(vc, watch(ids[0]), opts), PLAY_TIMEOUT_MS);
          setSaved(vc.id);
          await i.editReply(`📻 Mix ditemukan: memuat **${ids.length}** lagu ke queue...`);
          loadMixRest(vc, ids.slice(1).map(watch), opts, i.guildId); // tidak di-await
          return;
        }
      }

      let input = cleanUrl(query); // Mix gagal diambil -> buang list=RD... dan putar satu lagu
      if (!USE_NATIVE && !/^https?:\/\//i.test(query)) {
        // Mode yt-dlp: teks biasa dicari dulu lewat yt-dlp. Mode native: plugin mencari sendiri.
        input = await searchYoutube(query);
      }
      await withTimeout(distube.play(vc, input, opts), PLAY_TIMEOUT_MS);
      setSaved(vc.id);
      return i.editReply(`🔎 Mencari **${query.slice(0, 100)}**...`);
    } catch (err) {
      console.error('[music] play gagal:', err);
      if (err.cause) console.error('[music] cause:', err.cause);
      return i.editReply(`❌ Tidak bisa memutar: \`${String(err.message || err).slice(0, 200)}\``);
    }
  }
);

// ------------------------------------------------------------------ /join & /leave (24/7)
def(new SlashCommandBuilder().setName('join').setDescription('Panggil bot ke voice channel kamu (stay 24/7)'), async (i) => {
  const vc = userVoice(i);
  if (!vc) return i.reply({ content: '❌ Masuk ke voice channel dulu.', flags: EPHEMERAL });
  await i.deferReply({ flags: EPHEMERAL });
  await distube.voices.join(vc);
  setSaved(vc.id);
  return i.editReply(`✅ Masuk ke **${vc.name}**. Mode 24/7 aktif: bot tidak akan keluar sendiri (pakai \`/leave\` untuk mengeluarkan).`);
});

def(new SlashCommandBuilder().setName('leave').setDescription('Keluarkan bot dari voice & matikan mode 24/7'), async (i) => {
  clearSaved(); // hapus dulu supaya tidak masuk ulang otomatis
  const q = queueOf(i);
  if (q) await q.stop().catch(() => {});
  const v = distube.voices.get(i.guildId);
  if (!v) return i.reply({ content: 'Bot tidak sedang di voice.', flags: EPHEMERAL });
  v.leave();
  return i.reply('👋 Bot keluar dari voice. Pakai `/join` atau `/play` untuk memanggil lagi.');
});

// ------------------------------------------------------------------ kontrol playback
def(new SlashCommandBuilder().setName('skip').setDescription('Lewati lagu sekarang'), async (i) => {
  const q = await needQueue(i);
  if (!q) return;
  if (q.songs.length <= 1 && !q.autoplay && q.repeatMode !== 2) {
    await q.stop();
    return i.reply('⏭️ Lagu terakhir dilewati. Queue kosong.');
  }
  await q.skip();
  return i.reply('⏭️ Dilewati.');
});

def(new SlashCommandBuilder().setName('previous').setDescription('Kembali ke lagu sebelumnya'), async (i) => {
  const q = await needQueue(i);
  if (!q) return;
  if (!q.previousSongs?.length) return i.reply({ content: '❌ Tidak ada lagu sebelumnya.', flags: EPHEMERAL });
  await q.previous();
  return i.reply('⏮️ Kembali ke lagu sebelumnya.');
});

def(new SlashCommandBuilder().setName('stop').setDescription('Hentikan musik & kosongkan queue (bot tetap di voice)'), async (i) => {
  const q = await needQueue(i);
  if (!q) return;
  await q.stop();
  return i.reply('⏹️ Musik dihentikan. Bot tetap standby di voice.');
});

def(new SlashCommandBuilder().setName('pause').setDescription('Jeda lagu'), async (i) => {
  const q = await needQueue(i);
  if (!q) return;
  if (q.paused) return i.reply({ content: 'Sudah dijeda.', flags: EPHEMERAL });
  q.pause();
  return i.reply('⏸️ Dijeda.');
});

def(new SlashCommandBuilder().setName('resume').setDescription('Lanjutkan lagu'), async (i) => {
  const q = await needQueue(i);
  if (!q) return;
  if (!q.paused) return i.reply({ content: 'Lagu tidak sedang dijeda.', flags: EPHEMERAL });
  q.resume();
  return i.reply('▶️ Dilanjutkan.');
});

def(
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Atur volume (1-150)')
    .addIntegerOption((o) => o.setName('persen').setDescription('1 - 150').setMinValue(1).setMaxValue(150).setRequired(true)),
  async (i) => {
    const q = await needQueue(i);
    if (!q) return;
    const v = i.options.getInteger('persen', true);
    q.setVolume(v);
    return i.reply(`🔊 Volume: **${v}%**`);
  }
);

def(
  new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Atur mode ulang')
    .addStringOption((o) =>
      o
        .setName('mode')
        .setDescription('Mode')
        .setRequired(true)
        .addChoices({ name: 'Mati', value: '0' }, { name: 'Lagu ini', value: '1' }, { name: 'Seluruh queue', value: '2' })
    ),
  async (i) => {
    const q = await needQueue(i);
    if (!q) return;
    const mode = Number(i.options.getString('mode', true));
    q.setRepeatMode(mode);
    return i.reply(`🔁 Loop: **${['mati', 'lagu ini', 'seluruh queue'][mode]}**`);
  }
);

def(new SlashCommandBuilder().setName('shuffle').setDescription('Acak urutan queue'), async (i) => {
  const q = await needQueue(i);
  if (!q) return;
  await q.shuffle();
  return i.reply('🔀 Queue diacak.');
});

def(new SlashCommandBuilder().setName('autoplay').setDescription('Putar lagu rekomendasi otomatis saat queue habis'), async (i) => {
  const q = await needQueue(i);
  if (!q) return;
  const on = q.toggleAutoplay();
  return i.reply(`📻 Autoplay: **${on ? 'ON' : 'OFF'}**`);
});

def(
  new SlashCommandBuilder()
    .setName('seek')
    .setDescription('Loncat ke detik tertentu')
    .addIntegerOption((o) => o.setName('detik').setDescription('Posisi (detik)').setMinValue(0).setRequired(true)),
  async (i) => {
    const q = await needQueue(i);
    if (!q) return;
    const s = i.options.getInteger('detik', true);
    q.seek(s);
    return i.reply(`⏩ Loncat ke **${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}**`);
  }
);

def(
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Hapus lagu dari queue')
    .addIntegerOption((o) => o.setName('nomor').setDescription('Nomor di /queue (mulai 2)').setMinValue(2).setRequired(true)),
  async (i) => {
    const q = await needQueue(i);
    if (!q) return;
    const n = i.options.getInteger('nomor', true);
    if (n > q.songs.length) return i.reply({ content: '❌ Nomor tidak ada di queue.', flags: EPHEMERAL });
    const [song] = q.songs.splice(n - 1, 1);
    return i.reply({ content: `🗑️ **${song.name}** dihapus dari queue.`, allowedMentions: NO_PING });
  }
);

// ------------------------------------------------------------------ info
def(new SlashCommandBuilder().setName('queue').setDescription('Lihat antrean lagu'), async (i) => {
  const q = queueOf(i);
  if (!q || !q.songs.length) return i.reply({ content: '📭 Queue kosong.', flags: EPHEMERAL });
  const [now, ...rest] = q.songs;
  const lines = rest.slice(0, 10).map((s, idx) => `**${idx + 2}.** ${s.name} \`${s.formattedDuration}\``);
  const more = rest.length > 10 ? `\n… dan ${rest.length - 10} lagu lagi` : '';
  const e = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle('📃 Queue')
    .setDescription(`**Sekarang:** [${now.name}](${now.url}) \`${now.formattedDuration}\`\n\n${lines.join('\n') || '_Tidak ada lagu berikutnya_'}${more}`)
    .setFooter({ text: `${q.songs.length} lagu • ${q.formattedDuration} • Loop: ${['mati', 'lagu', 'queue'][q.repeatMode]}` });
  return i.reply({ embeds: [e], allowedMentions: NO_PING });
});

def(new SlashCommandBuilder().setName('nowplaying').setDescription('Lagu yang sedang diputar'), async (i) => {
  const q = queueOf(i);
  const song = q?.songs[0];
  if (!song) return i.reply({ content: '❌ Tidak ada lagu yang sedang diputar.', flags: EPHEMERAL });
  const e = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle('🎶 Sedang diputar')
    .setDescription(`**[${song.name}](${song.url})**\n\`${q.formattedCurrentTime} / ${song.formattedDuration}\``)
    .addFields({ name: 'Diminta oleh', value: `${song.user}`, inline: true }, { name: 'Volume', value: `${q.volume}%`, inline: true });
  if (song.thumbnail) e.setThumbnail(song.thumbnail);
  return i.reply({ embeds: [e], allowedMentions: NO_PING });
});

module.exports = { commands: list, initMusic, restoreMusic };
