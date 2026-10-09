// Fitur musik (mirip Jockie Music) memakai DisTube.
// Engine utama: @distube/youtube (native, tanpa spawn proses => cepat). Cadangan: yt-dlp.
// Ganti engine lewat env var MUSIC_ENGINE=ytdlp (kembali ke setup lama) tanpa ubah kode.
// Mode 24/7: bot TIDAK keluar saat voice kosong / queue habis / stop. Satu-satunya cara keluar: /leave.
// Channel voice terakhir disimpan di tabel settings, jadi bot masuk lagi otomatis setelah restart / ke-disconnect.
// FFmpeg: memakai ffmpeg sistem (PATH). ffmpeg-static dibuang karena crash SIGSEGV di container Railway..
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
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

// 'native' (default) atau 'ytdlp'
const USE_NATIVE = YouTubePlugin && (process.env.MUSIC_ENGINE || 'native').toLowerCase() !== 'ytdlp';

let distube = null;

// Lokasi binary yt-dlp bawaan @distube/yt-dlp (src/music.js -> ../node_modules/...)
const YTDLP = path.join(__dirname, '..', 'node_modules', '@distube', 'yt-dlp', 'bin', 'yt-dlp');

// @distube/yt-dlp masih mengirim opsi lama --no-call-home. yt-dlp terbaru mencetak "Deprecated Feature"
// sehingga JSON.parse di plugin error dan bot crash. Solusi: bungkus binary dengan skrip yang membuang opsi itu.
// Aman dijalankan berulang (idempotent), dipanggil tiap bot start.
function patchYtDlp() {
  try {
    const dir = path.dirname(YTDLP);
    const real = path.join(dir, 'yt-dlp.real');
    if (!fs.existsSync(YTDLP)) return;

    const wrapper = [
      '#!/bin/sh',
      'real="$(dirname "$0")/yt-dlp.real"',
      'for a in "$@"; do',
      '  shift',
      '  if [ "$a" != "--no-call-home" ]; then set -- "$@" "$a"; fi',
      'done',
      `exec "$real" --js-runtimes node --remote-components ejs:github "$@"`,
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
    console.log('[music] yt-dlp dipatch (--no-call-home dibuang, JS runtime node aktif)');
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

// ------------------------------------------------------------------ simpan channel 24/7
const getSaved = () => db.prepare('SELECT value FROM settings WHERE key=?').get(KEY)?.value || null;
const setSaved = (id) =>
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY, String(id));
const clearSaved = () => db.prepare('DELETE FROM settings WHERE key=?').run(KEY);

// ------------------------------------------------------------------ init
function initMusic(client) {
  // Cek versi library voice (boleh dihapus kalau sudah tidak perlu)
  console.log(generateDependencyReport());

  patchYtDlp(); // harus sebelum DisTube dibuat (yt-dlp tetap jadi cadangan / untuk situs selain YouTube)

  // Urutan plugin penting: plugin pertama yang cocok dengan input yang dipakai.
  const plugins = USE_NATIVE ? [new YouTubePlugin(), new YtDlpPlugin({ update: false })] : [new YtDlpPlugin({ update: false })];
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
      queue.textChannel
        ?.send({ content: `➕ **${song.name}** (${song.formattedDuration}) masuk queue — oleh ${song.user}`, allowedMentions: NO_PING })
        .catch(() => {});
    })
    .on('addList', (queue, playlist) => {
      queue.textChannel
        ?.send({ content: `📃 Playlist **${playlist.name}** (${playlist.songs.length} lagu) masuk queue.`, allowedMentions: NO_PING })
        .catch(() => {});
    })
    .on('error', (err, queue) => {
      console.error('[music] error:', err);
      queue?.textChannel?.send(`❌ Gagal memutar: \`${String(err.message || err).slice(0, 200)}\``).catch(() => {});
    });

  distube.on('finish', (queue) => {
    console.log('[music] queue selesai (bisa karena stream putus, cek log ffmpeg di atas)');
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
    const query = i.options.getString('query', true);
    try {
      let input = query;
      if (!USE_NATIVE && !/^https?:\/\//i.test(query)) {
        // Mode yt-dlp: teks biasa dicari dulu lewat yt-dlp. Mode native: plugin mencari sendiri.
        input = await searchYoutube(query);
      }
      await distube.play(vc, input, { member: i.member, textChannel: i.channel });
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
