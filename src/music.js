// Fitur musik (mirip Jockie Music) memakai Lavalink (lavalink-client).
const { SlashCommandBuilder, EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { LavalinkManager } = require('lavalink-client');
const { db } = require('./db');

const EPHEMERAL = MessageFlags.Ephemeral;
const NO_PING = { parse: [] };
const KEY = 'music_vc';
const LOOP_MODES = ['off', 'track', 'queue'];
const LOOP_LABEL = { off: 'mati', track: 'lagu ini', queue: 'seluruh queue' };

let lava = null;
let discord = null;
let lavaReady = false;

// ------------------------------------------------------------------ util
function fmt(ms) {
  if (!ms || ms < 0) return '0:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
const durOf = (t) => (t.info.isStream ? 'Live' : fmt(t.info.duration));

const sendText = (player, payload) => {
  const ch = player.textChannelId && discord.channels.cache.get(player.textChannelId);
  return ch
    ?.send({ allowedMentions: NO_PING, ...(typeof payload === 'string' ? { content: payload } : payload) })
    .catch(() => {});
};

// ------------------------------------------------------------------ simpan channel 24/7
const getSaved = () => db.prepare('SELECT value FROM settings WHERE key=?').get(KEY)?.value || null;
const setSaved = (id) =>
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY, String(id));
const clearSaved = () => db.prepare('DELETE FROM settings WHERE key=?').run(KEY);

// ------------------------------------------------------------------ autoplay (YouTube Mix dari lagu terakhir)
async function doAutoplay(player) {
  const last = player.queue.current || player.queue.previous[0];
  if (!last || last.info.sourceName !== 'youtube') return false;
  const id = last.info.identifier;
  const res = await player.search({ query: `https://www.youtube.com/watch?v=${id}&list=RD${id}` }, last.requester);
  if (res.loadType !== 'playlist') return false;
  const seen = new Set([id, ...player.queue.previous.map((t) => t.info.identifier)]);
  const fresh = res.tracks.filter((t) => !seen.has(t.info.identifier)).slice(0, 10);
  if (!fresh.length) return false;
  await player.queue.add(fresh);
  return true;
}

// Hapus semua player setelah node Lavalink putus & tersambung lagi, lalu masuk ulang ke voice 24/7.
async function resetStalePlayers() {
  for (const p of [...lava.players.values()]) {
    if (p.queue.current) sendText(p, '⚠️ Koneksi ke Lavalink sempat putus, queue direset. Silakan `/play` lagi.');
    await p.destroy('node reconnect').catch(() => {});
  }
  await restoreMusic(discord);
}

// ------------------------------------------------------------------ init
function initMusic(client) {
  discord = client;

  lava = new LavalinkManager({
    nodes: [
      {
        id: 'main',
        host: process.env.LAVALINK_HOST || 'localhost',
        port: Number(process.env.LAVALINK_PORT) || 2333,
        authorization: process.env.LAVALINK_PASSWORD || 'youshallnotpass',
        secure: process.env.LAVALINK_SECURE === '1',
        retryAmount: 1000,
        retryDelay: 5000,
      },
    ],
    sendToShard: (guildId, payload) => client.guilds.cache.get(guildId)?.shard?.send(payload),
    autoSkip: true, // lagu error/stuck otomatis lanjut ke berikutnya
    // id sementara; diisi id bot yang asli saat lava.init() di ensureLavalink()
    client: { id: process.env.CLIENT_ID || '0', username: 'VDP Ranked' },
    playerOptions: {
      defaultSearchPlatform: process.env.MUSIC_SEARCH || 'ytsearch', // 'scsearch' = SoundCloud
      volumeDecrementer: 1,
      clientBasedPositionUpdateInterval: 150,
      onDisconnect: { autoReconnect: true, destroyPlayer: false },
      // tidak ada onEmptyQueue.destroyAfterMs -> bot tidak keluar sendiri (24/7)
    },
    queueOptions: { maxPreviousTracks: 25 },
  });

  client.on('raw', (d) => {
    try {
      lava.sendRawData(d);
    } catch {}
  });

  let nodeWasDown = false;
  lava.nodeManager
    .on('connect', (node) => {
      console.log(`[music] Lavalink node "${node.id}" terhubung`);
      // Node hidup lagi setelah putus: player lama sudah hilang di sisi Lavalink, jadi reset supaya tidak "zombie".
      if (nodeWasDown) {
        nodeWasDown = false;
        resetStalePlayers().catch((err) => console.warn('[music] reset player gagal:', err.message));
      }
    })
    .on('disconnect', (node, reason) => {
      nodeWasDown = true;
      console.warn(`[music] node "${node.id}" putus:`, reason?.reason || reason);
    })
    .on('error', (node, err) => console.error(`[music] node "${node.id}" error:`, err?.message || err));

  lava
    .on('trackStart', (player, track) => {
      if (!track) return;
      const e = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('🎶 Sedang diputar')
        .setDescription(`**[${track.info.title}](${track.info.uri})**`)
        .addFields(
          { name: 'Durasi', value: durOf(track), inline: true },
          { name: 'Diminta oleh', value: `${track.requester ?? '-'}`, inline: true },
          { name: 'Volume', value: `${player.volume}%`, inline: true }
        );
      if (track.info.artworkUrl) e.setThumbnail(track.info.artworkUrl);
      sendText(player, { embeds: [e] });
    })
    .on('trackError', (player, track, payload) => {
      console.error('[music] trackError:', payload?.exception || payload);
      sendText(player, `❌ Gagal memutar **${track?.info?.title ?? 'lagu'}**: \`${String(payload?.exception?.message || 'error').slice(0, 200)}\``);
    })
    .on('trackStuck', (player, track) => {
      console.warn('[music] trackStuck:', track?.info?.title);
      sendText(player, `⚠️ **${track?.info?.title ?? 'Lagu'}** macet, dilewati.`);
    })
    .on('queueEnd', async (player) => {
      if (!player.get('autoplay')) return;
      try {
        if (await doAutoplay(player)) await player.play();
      } catch (err) {
        console.warn('[music] autoplay gagal:', err.message);
      }
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

async function ensureLavalink(client) {
  if (lavaReady) return;
  await lava.init({ id: client.user.id, username: client.user.username });
  lavaReady = true;
}

// Dipanggil saat bot ready: init Lavalink lalu masuk lagi ke channel voice terakhir
async function restoreMusic(client) {
  if (!lava) return;
  try {
    await ensureLavalink(client);
    const id = getSaved();
    if (!id) return;
    const ch = await client.channels.fetch(id);
    if (!ch || !ch.isVoiceBased()) return clearSaved();
    const existing = lava.getPlayer(ch.guild.id);
    if (existing?.connected) return;
    // tunggu node Lavalink siap (maks 30 detik)
    for (let n = 0; n < 30 && !lava.useable; n++) await new Promise((r) => setTimeout(r, 1000));
    if (!lava.useable) return console.warn('[music] Lavalink belum siap, lewati restore voice');
    const player = existing || lava.createPlayer({ guildId: ch.guild.id, voiceChannelId: ch.id, selfDeaf: true, volume: 100 });
    await player.connect();
    console.log(`🎧 24/7: masuk ke voice #${ch.name}`);
  } catch (err) {
    console.warn('[music] gagal masuk ulang voice:', err.message);
  }
}

// ------------------------------------------------------------------ helper command
const list = [];
const def = (data, execute) => list.push({ data, execute });

const playerOf = (i) => lava?.getPlayer(i.guildId);
const userVoice = (i) => i.member?.voice?.channel || null;

// Pastikan ada player aktif & user di voice channel yang sama. Mengembalikan player atau null (sudah membalas).
async function needPlayer(i) {
  const p = playerOf(i);
  if (!p || !p.queue.current) {
    await i.reply({ content: '❌ Tidak ada lagu yang sedang diputar.', flags: EPHEMERAL });
    return null;
  }
  const vc = userVoice(i);
  if (!vc || vc.id !== p.voiceChannelId) {
    await i.reply({ content: '❌ Kamu harus berada di voice channel yang sama dengan bot.', flags: EPHEMERAL });
    return null;
  }
  return p;
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
      if (!lava?.useable) return i.editReply('❌ Server Lavalink belum terhubung, coba lagi sebentar.');

      let player = lava.getPlayer(i.guildId);
      if (player?.connected && player.voiceChannelId !== vc.id && player.playing) {
        return i.editReply('❌ Bot sedang memutar musik di voice channel lain.');
      }
      if (!player) {
        player = lava.createPlayer({ guildId: i.guildId, voiceChannelId: vc.id, textChannelId: i.channelId, selfDeaf: true, volume: 100 });
      }
      player.options.voiceChannelId = vc.id;
      player.textChannelId = i.channelId;
      if (!player.connected) await player.connect();

      const res = await player.search({ query }, i.user);
      if (res.loadType === 'error') return i.editReply(`❌ Tidak bisa memutar: \`${String(res.exception?.message || 'error').slice(0, 200)}\``);
      if (res.loadType === 'empty' || !res.tracks.length) return i.editReply('❌ Tidak ada hasil.');

      let msg;
      if (res.loadType === 'playlist') {
        await player.queue.add(res.tracks);
        msg = `📃 Playlist **${res.playlist?.title || res.playlist?.name || 'Playlist'}** (${res.tracks.length} lagu) masuk queue.`;
      } else {
        const t = res.tracks[0];
        await player.queue.add(t);
        msg = `➕ **${t.info.title}** (${durOf(t)}) masuk queue — oleh ${i.user}`;
      }

      if (!player.playing && !player.paused) await player.play();
      setSaved(vc.id);
      return i.editReply({ content: msg, allowedMentions: NO_PING });
    } catch (err) {
      console.error('[music] play gagal:', err);
      return i.editReply(`❌ Tidak bisa memutar: \`${String(err.message || err).slice(0, 200)}\``);
    }
  }
);

// ------------------------------------------------------------------ /join & /leave (24/7)
def(new SlashCommandBuilder().setName('join').setDescription('Panggil bot ke voice channel kamu (stay 24/7)'), async (i) => {
  const vc = userVoice(i);
  if (!vc) return i.reply({ content: '❌ Masuk ke voice channel dulu.', flags: EPHEMERAL });
  await i.deferReply({ flags: EPHEMERAL });
  if (!lava?.useable) return i.editReply('❌ Server Lavalink belum terhubung, coba lagi sebentar.');
  const player =
    lava.getPlayer(i.guildId) ||
    lava.createPlayer({ guildId: i.guildId, voiceChannelId: vc.id, textChannelId: i.channelId, selfDeaf: true, volume: 100 });
  player.options.voiceChannelId = vc.id;
  await player.connect();
  setSaved(vc.id);
  return i.editReply(`✅ Masuk ke **${vc.name}**. Mode 24/7 aktif: bot tidak akan keluar sendiri (pakai \`/leave\` untuk mengeluarkan).`);
});

def(new SlashCommandBuilder().setName('leave').setDescription('Keluarkan bot dari voice & matikan mode 24/7'), async (i) => {
  clearSaved(); // hapus dulu supaya tidak masuk ulang otomatis
  const p = playerOf(i);
  if (!p) return i.reply({ content: 'Bot tidak sedang di voice.', flags: EPHEMERAL });
  await p.destroy('leave command').catch(() => {});
  return i.reply('👋 Bot keluar dari voice. Pakai `/join` atau `/play` untuk memanggil lagi.');
});

// ------------------------------------------------------------------ kontrol playback
def(new SlashCommandBuilder().setName('skip').setDescription('Lewati lagu sekarang'), async (i) => {
  const p = await needPlayer(i);
  if (!p) return;
  if (!p.queue.tracks.length) {
    if (p.get('autoplay') && (await doAutoplay(p).catch(() => false))) {
      await p.skip();
      return i.reply('⏭️ Dilewati.');
    }
    await p.stopPlaying(true, false);
    return i.reply('⏭️ Lagu terakhir dilewati. Queue kosong.');
  }
  await p.skip();
  return i.reply('⏭️ Dilewati.');
});

def(new SlashCommandBuilder().setName('previous').setDescription('Kembali ke lagu sebelumnya'), async (i) => {
  const p = await needPlayer(i);
  if (!p) return;
  if (!p.queue.previous.length) return i.reply({ content: '❌ Tidak ada lagu sebelumnya.', flags: EPHEMERAL });
  const prev = await p.queue.shiftPrevious();
  const cur = p.queue.current;
  if (cur) await p.queue.splice(0, 0, cur); // lagu sekarang jadi berikutnya
  await p.play({ clientTrack: prev });
  return i.reply('⏮️ Kembali ke lagu sebelumnya.');
});

def(new SlashCommandBuilder().setName('stop').setDescription('Hentikan musik & kosongkan queue (bot tetap di voice)'), async (i) => {
  const p = await needPlayer(i);
  if (!p) return;
  p.set('autoplay', false);
  await p.stopPlaying(true, false);
  return i.reply('⏹️ Musik dihentikan. Bot tetap standby di voice.');
});

def(new SlashCommandBuilder().setName('pause').setDescription('Jeda lagu'), async (i) => {
  const p = await needPlayer(i);
  if (!p) return;
  if (p.paused) return i.reply({ content: 'Sudah dijeda.', flags: EPHEMERAL });
  await p.pause();
  return i.reply('⏸️ Dijeda.');
});

def(new SlashCommandBuilder().setName('resume').setDescription('Lanjutkan lagu'), async (i) => {
  const p = await needPlayer(i);
  if (!p) return;
  if (!p.paused) return i.reply({ content: 'Lagu tidak sedang dijeda.', flags: EPHEMERAL });
  await p.resume();
  return i.reply('▶️ Dilanjutkan.');
});

def(
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Atur volume (1-150)')
    .addIntegerOption((o) => o.setName('persen').setDescription('1 - 150').setMinValue(1).setMaxValue(150).setRequired(true)),
  async (i) => {
    const p = await needPlayer(i);
    if (!p) return;
    const v = i.options.getInteger('persen', true);
    await p.setVolume(v);
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
    const p = await needPlayer(i);
    if (!p) return;
    const mode = LOOP_MODES[Number(i.options.getString('mode', true))];
    await p.setRepeatMode(mode);
    return i.reply(`🔁 Loop: **${LOOP_LABEL[mode]}**`);
  }
);

def(new SlashCommandBuilder().setName('shuffle').setDescription('Acak urutan queue'), async (i) => {
  const p = await needPlayer(i);
  if (!p) return;
  await p.queue.shuffle();
  return i.reply('🔀 Queue diacak.');
});

def(new SlashCommandBuilder().setName('autoplay').setDescription('Putar lagu rekomendasi otomatis saat queue habis'), async (i) => {
  const p = await needPlayer(i);
  if (!p) return;
  const on = !p.get('autoplay');
  p.set('autoplay', on);
  return i.reply(`📻 Autoplay: **${on ? 'ON' : 'OFF'}**`);
});

def(
  new SlashCommandBuilder()
    .setName('seek')
    .setDescription('Loncat ke detik tertentu')
    .addIntegerOption((o) => o.setName('detik').setDescription('Posisi (detik)').setMinValue(0).setRequired(true)),
  async (i) => {
    const p = await needPlayer(i);
    if (!p) return;
    if (!p.queue.current.info.isSeekable) return i.reply({ content: '❌ Lagu ini tidak bisa di-seek.', flags: EPHEMERAL });
    const s = i.options.getInteger('detik', true);
    await p.seek(s * 1000);
    return i.reply(`⏩ Loncat ke **${fmt(s * 1000)}**`);
  }
);

def(
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Hapus lagu dari queue')
    .addIntegerOption((o) => o.setName('nomor').setDescription('Nomor di /queue (mulai 2)').setMinValue(2).setRequired(true)),
  async (i) => {
    const p = await needPlayer(i);
    if (!p) return;
    const n = i.options.getInteger('nomor', true);
    const idx = n - 2; // nomor 1 = lagu yang sedang diputar
    const track = p.queue.tracks[idx];
    if (!track) return i.reply({ content: '❌ Nomor tidak ada di queue.', flags: EPHEMERAL });
    await p.queue.remove(idx);
    return i.reply({ content: `🗑️ **${track.info.title}** dihapus dari queue.`, allowedMentions: NO_PING });
  }
);

// ------------------------------------------------------------------ info
const QUEUE_PER_PAGE = 10;
const clip = (str, n = 70) => (str.length > n ? `${str.slice(0, n - 1)}…` : str);

// Susun isi satu halaman queue (dibaca langsung dari queue yang sedang berjalan).
function queuePage(p, wanted) {
  const now = p?.queue.current;
  if (!now) return { payload: { content: '📭 Queue kosong.', embeds: [], components: [] }, page: 0, pages: 1 };

  const rest = p.queue.tracks;
  const pages = Math.max(1, Math.ceil(rest.length / QUEUE_PER_PAGE));
  const page = Math.min(Math.max(wanted, 0), pages - 1);
  const start = page * QUEUE_PER_PAGE;
  const lines = rest
    .slice(start, start + QUEUE_PER_PAGE)
    .map((t, idx) => `**${start + idx + 2}.** ${clip(t.info.title)} \`${durOf(t)}\``);
  const total = [now, ...rest].reduce((a, t) => a + (t.info.isStream ? 0 : t.info.duration || 0), 0);

  const e = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle('📃 Queue')
    .setDescription(`**Sekarang:** [${clip(now.info.title, 80)}](${now.info.uri}) \`${durOf(now)}\`\n\n${lines.join('\n') || '_Tidak ada lagu berikutnya_'}`)
    .setFooter({ text: `Halaman ${page + 1}/${pages} • ${rest.length + 1} lagu • ${fmt(total)} • Loop: ${LOOP_LABEL[p.repeatMode]}` });

  const btn = (id, emoji, disabled) => new ButtonBuilder().setCustomId(id).setEmoji(emoji).setStyle(ButtonStyle.Secondary).setDisabled(disabled);
  const components =
    pages > 1
      ? [
          new ActionRowBuilder().addComponents(
            btn('mq_first', '⏮️', page === 0),
            btn('mq_prev', '◀️', page === 0),
            new ButtonBuilder().setCustomId('mq_page').setLabel(`${page + 1}/${pages}`).setStyle(ButtonStyle.Primary).setDisabled(true),
            btn('mq_next', '▶️', page === pages - 1),
            btn('mq_last', '⏭️', page === pages - 1)
          ),
        ]
      : [];
  return { payload: { embeds: [e], components }, page, pages };
}

def(new SlashCommandBuilder().setName('queue').setDescription('Lihat antrean lagu'), async (i) => {
  const first = queuePage(playerOf(i), 0);
  if (!playerOf(i)?.queue.current) return i.reply({ content: '📭 Queue kosong.', flags: EPHEMERAL });

  await i.reply({ ...first.payload, allowedMentions: NO_PING });
  if (first.pages <= 1) return;

  let page = first.page;
  const msg = await i.fetchReply();
  const collector = msg.createMessageComponentCollector({ time: 120000 });

  collector.on('collect', async (b) => {
    if (b.user.id !== i.user.id) {
      return b.reply({ content: 'Hanya yang menjalankan `/queue` yang bisa ganti halaman. Jalankan `/queue` sendiri ya.', flags: EPHEMERAL }).catch(() => {});
    }
    const target = { mq_first: 0, mq_prev: page - 1, mq_next: page + 1, mq_last: Infinity }[b.customId];
    if (target === undefined) return;
    const r = queuePage(playerOf(i), target);
    page = r.page;
    await b.update({ ...r.payload, allowedMentions: NO_PING }).catch(() => {});
    if (!playerOf(i)?.queue.current) collector.stop();
  });

  // Setelah 2 menit tombol dihapus; jalankan /queue lagi untuk membuka ulang.
  collector.on('end', () => i.editReply({ components: [] }).catch(() => {}));
});

def(new SlashCommandBuilder().setName('nowplaying').setDescription('Lagu yang sedang diputar'), async (i) => {
  const p = playerOf(i);
  const t = p?.queue.current;
  if (!t) return i.reply({ content: '❌ Tidak ada lagu yang sedang diputar.', flags: EPHEMERAL });
  const e = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle('🎶 Sedang diputar')
    .setDescription(`**[${t.info.title}](${t.info.uri})**\n\`${fmt(p.position)} / ${durOf(t)}\``)
    .addFields({ name: 'Diminta oleh', value: `${t.requester ?? '-'}`, inline: true }, { name: 'Volume', value: `${p.volume}%`, inline: true });
  if (t.info.artworkUrl) e.setThumbnail(t.info.artworkUrl);
  return i.reply({ embeds: [e], allowedMentions: NO_PING });
});

module.exports = { commands: list, initMusic, restoreMusic };
