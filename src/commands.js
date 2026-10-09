const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const crypto = require('crypto');
const cfg = require('./config');
const { db, getSeason, setSeason, setFrozen, clearFrozen, isFrozen, nowSec, getStat, overall } = require('./db');
const { lookupUser, getDescription, profileUrl } = require('./roblox');
const { rankPayload, overallLabel, emblemOf, rowTier } = require('./embeds');
const { sendAdmin, freezeRow, isMod } = require('./matches');
const { syncRank } = require('./roles');
const party = require('./party');

const EPHEMERAL = MessageFlags.Ephemeral;
const MEDALS = ['🥇', '🥈', '🥉'];
const WINDOWS = { weekly: 7, monthly: 30 };
const MAX_MMR = 9999;
const REPORT_CATEGORIES = [
  ['🚫 Cheating', 'Cheating'],
  ['🚫 Exploiting', 'Exploiting'],
  ['🚫 Boosting', 'Boosting'],
  ['🚫 Win Trading', 'Win Trading'],
  ['🚫 Toxicity', 'Toxicity'],
  ['🚫 Match Manipulation', 'Match Manipulation'],
  ['🚫 Fake Result', 'Fake Result'],
];

// Riwayat penyesuaian MMR manual (/adjust)
db.exec(`
CREATE TABLE IF NOT EXISTS mmr_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  role TEXT NOT NULL,
  mmr_before INTEGER NOT NULL,
  mmr_after INTEGER NOT NULL,
  reason TEXT,
  by TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
`);

const commands = new Map();
const add = (data, execute) => commands.set(data.name, { data, execute });

// ---------------------------------------------------------------- /verify
add(
  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Hubungkan akun Discord kamu dengan akun Roblox')
    .addStringOption((o) => o.setName('roblox_username').setDescription('Username Roblox kamu').setRequired(true)),
  async (i) => {
    await i.deferReply({ flags: EPHEMERAL });

    const existing = db.prepare('SELECT roblox_name FROM users WHERE discord_id=?').get(i.user.id);
    if (existing) {
      return i.editReply(`✅ Kamu sudah terverifikasi sebagai **${existing.roblox_name}**. Hubungi admin kalau perlu ganti akun.`);
    }

    const name = i.options.getString('roblox_username', true).trim();
    const ru = await lookupUser(name);
    if (!ru) return i.editReply(`❌ Username Roblox **${name}** tidak ditemukan.`);

    const taken = db.prepare('SELECT discord_id FROM users WHERE roblox_id=?').get(ru.id);
    if (taken) return i.editReply('❌ Akun Roblox itu sudah terhubung ke akun Discord lain.');

    const code = `VDP-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    db.prepare(
      `INSERT INTO verify_pending (discord_id, roblox_id, roblox_name, code) VALUES (?,?,?,?)
       ON CONFLICT(discord_id) DO UPDATE SET roblox_id=excluded.roblox_id, roblox_name=excluded.roblox_name, code=excluded.code, created_at=strftime('%s','now')`
    ).run(i.user.id, ru.id, ru.name, code);

    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle('🔐 Verifikasi Roblox')
      .setDescription(
        `Akun: **${ru.name}**\n\n` +
          `1. Buka profil Roblox kamu → edit **About / Description**.\n` +
          `2. Tempel kode ini: \`${code}\`\n` +
          `3. Simpan, lalu tekan tombol di bawah.\n\n` +
          `Setelah terverifikasi, kode boleh dihapus.`
      );
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('v:confirm').setLabel('✅ Saya sudah pasang kode').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setLabel('Buka Profil').setStyle(ButtonStyle.Link).setURL(profileUrl(ru.id))
    );
    return i.editReply({ embeds: [embed], components: [row] });
  }
);

async function handleVerifyConfirm(i) {
  await i.deferReply({ flags: EPHEMERAL });
  const p = db.prepare('SELECT * FROM verify_pending WHERE discord_id=?').get(i.user.id);
  if (!p) return i.editReply('Tidak ada verifikasi yang tertunda. Jalankan `/verify` dulu.');

  const desc = await getDescription(p.roblox_id);
  if (!desc.includes(p.code)) {
    return i.editReply(`❌ Kode \`${p.code}\` belum ditemukan di profil **${p.roblox_name}**. Pastikan sudah disimpan, lalu coba lagi.`);
  }

  try {
    db.prepare('INSERT INTO users (discord_id, roblox_id, roblox_name) VALUES (?,?,?)').run(i.user.id, p.roblox_id, p.roblox_name);
  } catch {
    return i.editReply('❌ Akun Roblox itu sudah terhubung ke akun Discord lain.');
  }
  db.prepare('DELETE FROM verify_pending WHERE discord_id=?').run(i.user.id);
  return i.editReply(`✅ Berhasil! Discord ↔ Roblox **${p.roblox_name}** (ID ${p.roblox_id}) terverifikasi.`);
}

// ---------------------------------------------------------------- /rank
add(
  new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Lihat rank, statistik & Ranked Points')
    .addUserOption((o) => o.setName('player').setDescription('Pemain lain (opsional)')),
  async (i) => {
    const user = i.options.getUser('player') || i.user;
    return i.reply(rankPayload(user));
  }
);

// ---------------------------------------------------------------- /matches
add(
  new SlashCommandBuilder()
    .setName('matches')
    .setDescription('Riwayat 10 match terakhir')
    .addUserOption((o) => o.setName('player').setDescription('Pemain lain (opsional)')),
  async (i) => {
    const user = i.options.getUser('player') || i.user;
    const rows = db
      .prepare(
        `SELECT mp.match_id, mp.role, mp.delta, mp.rp, m.winner, m.finished_at
         FROM match_players mp JOIN matches m ON m.id = mp.match_id
         WHERE mp.discord_id=? AND m.status='verified'
         ORDER BY m.id DESC LIMIT 10`
      )
      .all(user.id);

    if (!rows.length) return i.reply({ content: 'Belum ada match terverifikasi.', flags: EPHEMERAL });

    const lines = rows.map((r) => {
      const win = r.winner === r.role;
      const sign = r.delta >= 0 ? '+' : '';
      return (
        `**#${r.match_id}** ${win ? '🟢 WIN' : '🔴 LOSS'} ${sign}${r.delta} MMR • +${r.rp || 0} RP\n` +
        `${r.role === 'killer' ? '🔪 Killer' : '🏃 Survivor'} • <t:${r.finished_at}:R>`
      );
    });
    const embed = new EmbedBuilder().setColor(0x9b59b6).setTitle(`📈 MATCH HISTORY — ${user.username}`).setDescription(lines.join('\n\n'));
    return i.reply({ embeds: [embed] });
  }
);

// ---------------------------------------------------------------- leaderboard helpers
function topRows(kind, season, limit) {
  if (kind === 'overall') {
    return db
      .prepare(
        `SELECT discord_id, ROUND(AVG(mmr)) AS mmr FROM stats
         WHERE season=? AND games>0 GROUP BY discord_id HAVING SUM(games)>=?
         ORDER BY AVG(mmr) DESC LIMIT ?`
      )
      .all(season, cfg.placementGames, limit);
  }
  return db
    .prepare('SELECT discord_id, mmr FROM stats WHERE season=? AND role=? AND games>=? ORDER BY mmr DESC LIMIT ?')
    .all(season, kind, cfg.placementGames, limit);
}

// Leaderboard satu season penuh
function seasonRows(kind, season) {
  if (kind === 'rp') {
    return db
      .prepare('SELECT discord_id, points AS v FROM rp WHERE season=? AND points>0 ORDER BY points DESC LIMIT 10')
      .all(season)
      .map((r) => ({ discord_id: r.discord_id, text: `${r.v} RP` }));
  }
  if (kind === 'streak') {
    return db
      .prepare('SELECT discord_id, MAX(streak) AS v FROM stats WHERE season=? AND streak>0 GROUP BY discord_id ORDER BY v DESC LIMIT 10')
      .all(season)
      .map((r) => ({ discord_id: r.discord_id, text: `${r.v} win streak` }));
  }
  return topRows(kind, season, 10).map((r) => ({ discord_id: r.discord_id, mmr: r.mmr, text: `${r.mmr} MMR` }));
}

// Leaderboard rolling window (weekly = 7 hari terakhir, monthly = 30 hari terakhir)
// Urut berdasarkan MMR yang didapat (net) atau RP yang dikumpulkan; minimal 3 match.
function windowRows(kind, season, days) {
  const since = nowSec() - days * 86400;
  const roleCond = kind === 'killer' || kind === 'survivor' ? 'AND mp.role=?' : '';
  const params = [season, since];
  if (roleCond) params.push(kind);
  const order = kind === 'rp' ? 'rp' : 'gain';

  const rows = db
    .prepare(
      `SELECT mp.discord_id,
              SUM(mp.delta) AS gain,
              SUM(mp.rp) AS rp,
              COUNT(*) AS games,
              SUM(CASE WHEN m.winner = mp.role THEN 1 ELSE 0 END) AS wins
       FROM match_players mp JOIN matches m ON m.id = mp.match_id
       WHERE m.status='verified' AND m.season=? AND m.finished_at>=? ${roleCond}
       GROUP BY mp.discord_id HAVING COUNT(*) >= 3
       ORDER BY ${order} DESC LIMIT 10`
    )
    .all(...params);

  return rows.map((r) => ({
    discord_id: r.discord_id,
    text:
      (kind === 'rp' ? `${r.rp} RP` : `${r.gain >= 0 ? '+' : ''}${r.gain} MMR`) + ` • ${r.wins}W/${r.games - r.wins}L`,
  }));
}

// ---------------------------------------------------------------- /leaderboard
add(
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Leaderboard ranked')
    .addStringOption((o) =>
      o
        .setName('kategori')
        .setDescription('Pilih kategori')
        .addChoices(
          { name: '🏆 Overall', value: 'overall' },
          { name: '🔪 Killer', value: 'killer' },
          { name: '🏃 Survivor', value: 'survivor' },
          { name: '🔥 Win Streak', value: 'streak' },
          { name: '💰 Ranked Points', value: 'rp' }
        )
    )
    .addStringOption((o) =>
      o
        .setName('periode')
        .setDescription('Periode (default: season ini)')
        .addChoices(
          { name: '📅 Season ini', value: 'season' },
          { name: '📅 Weekly (7 hari terakhir)', value: 'weekly' },
          { name: '📅 Monthly (30 hari terakhir)', value: 'monthly' }
        )
    ),
  async (i) => {
    const kind = i.options.getString('kategori') || 'overall';
    let period = i.options.getString('periode') || 'season';
    if (kind === 'streak') period = 'season'; // streak hanya relevan untuk season berjalan
    const season = getSeason();

    const rows = period === 'season' ? seasonRows(kind, season) : windowRows(kind, season, WINDOWS[period]);
    const kindTitle = { overall: '🏆 OVERALL', killer: '🔪 KILLER', survivor: '🏃 SURVIVOR', streak: '🔥 WIN STREAK', rp: '💰 RANKED POINTS' }[kind];
    const periodTitle = { season: `SEASON ${String(season).padStart(2, '0')}`, weekly: 'WEEKLY', monthly: 'MONTHLY' }[period];

    // Ikon tier per baris (dari MMR role pada board role, selain itu MMR keseluruhan)
    const tiers = rows.map((r) => rowTier(r.discord_id, r.mmr));
    const body = rows.length
      ? rows
          .map((r, idx) => `${MEDALS[idx] || `**${idx + 1}.**`} ${tiers[idx] ? `${tiers[idx].emoji} ` : ''}<@${r.discord_id}> — ${r.text}`)
          .join('\n')
      : period === 'season'
        ? 'Belum ada data untuk leaderboard ini.'
        : 'Belum ada pemain dengan minimal 3 match di periode ini.';

    const embed = new EmbedBuilder().setColor(0xf1c40f).setTitle(`${kindTitle} — ${periodTitle}`).setDescription(body);
    if (period !== 'season') {
      embed.setFooter({
        text: `${WINDOWS[period]} hari terakhir • diurutkan dari ${kind === 'rp' ? 'RP' : 'MMR'} yang didapat • minimal 3 match`,
      });
    }
    // Emblem tier pemain peringkat 1 sebagai thumbnail
    const files = [];
    const em = emblemOf(tiers[0]);
    if (em) {
      embed.setThumbnail(`attachment://${em.name}`);
      files.push(em.attachment);
    }
    return i.reply({ embeds: [embed], files, allowedMentions: { parse: [] } });
  }
);

// ---------------------------------------------------------------- /report
add(
  new SlashCommandBuilder()
    .setName('report')
    .setDescription('Laporkan pemain')
    .addUserOption((o) => o.setName('player').setDescription('Pemain yang dilaporkan').setRequired(true))
    .addStringOption((o) =>
      o
        .setName('kategori')
        .setDescription('Jenis pelanggaran')
        .setRequired(true)
        .addChoices(...REPORT_CATEGORIES.map(([name, value]) => ({ name, value })))
    )
    .addStringOption((o) => o.setName('detail').setDescription('Penjelasan / bukti (link screenshot)').setMaxLength(900)),
  async (i) => {
    const target = i.options.getUser('player', true);
    const category = i.options.getString('kategori', true);
    const details = i.options.getString('detail') || '-';

    if (target.id === i.user.id) return i.reply({ content: 'Tidak bisa report diri sendiri.', flags: EPHEMERAL });

    db.prepare('INSERT INTO reports (reporter, target, category, details) VALUES (?,?,?,?)').run(i.user.id, target.id, category, details);
    const count = db.prepare('SELECT COUNT(*) AS c FROM reports WHERE target=?').get(target.id).c;

    const embed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle('🚨 PLAYER REPORT')
      .addFields(
        { name: 'Target', value: `<@${target.id}> (${count} report)`, inline: true },
        { name: 'Pelapor', value: `<@${i.user.id}>`, inline: true },
        { name: 'Kategori', value: category, inline: true },
        { name: 'Detail', value: details }
      );
    await sendAdmin(i.client, {
      embeds: [embed],
      components: [freezeRow([{ id: target.id, name: target.username }])],
      allowedMentions: { parse: [] },
    });
    return i.reply({ content: '✅ Report terkirim ke admin.', flags: EPHEMERAL });
  }
);

// ---------------------------------------------------------------- /freeze & /unfreeze (admin)
add(
  new SlashCommandBuilder()
    .setName('freeze')
    .setDescription('Bekukan MMR pemain (tidak bisa antre, MMR/RP tidak berubah)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((o) => o.setName('player').setDescription('Pemain').setRequired(true))
    .addStringOption((o) => o.setName('alasan').setDescription('Alasan').setMaxLength(300)),
  async (i) => {
    if (!isMod(i)) return i.reply({ content: '❌ Hanya admin/mod.', flags: EPHEMERAL });
    const target = i.options.getUser('player', true);
    const reason = i.options.getString('alasan') || '-';
    setFrozen(target.id, reason, i.user.id);
    return i.reply({
      content: `🧊 MMR <@${target.id}> dibekukan.\nAlasan: ${reason}`,
      flags: EPHEMERAL,
      allowedMentions: { parse: [] },
    });
  }
);

add(
  new SlashCommandBuilder()
    .setName('unfreeze')
    .setDescription('Buka kembali MMR pemain yang dibekukan')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((o) => o.setName('player').setDescription('Pemain').setRequired(true)),
  async (i) => {
    if (!isMod(i)) return i.reply({ content: '❌ Hanya admin/mod.', flags: EPHEMERAL });
    const target = i.options.getUser('player', true);
    const was = isFrozen(target.id);
    clearFrozen(target.id);
    return i.reply({
      content: was ? `✅ MMR <@${target.id}> dibuka kembali.` : `<@${target.id}> tidak sedang dibekukan.`,
      flags: EPHEMERAL,
      allowedMentions: { parse: [] },
    });
  }
);

// ---------------------------------------------------------------- /adjust (admin)
add(
  new SlashCommandBuilder()
    .setName('adjust')
    .setDescription('Ubah MMR pemain secara manual (admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((o) => o.setName('player').setDescription('Pemain').setRequired(true))
    .addStringOption((o) =>
      o
        .setName('role')
        .setDescription('MMR role yang diubah')
        .setRequired(true)
        .addChoices({ name: '🔪 Killer', value: 'killer' }, { name: '🏃 Survivor', value: 'survivor' })
    )
    .addStringOption((o) =>
      o
        .setName('mode')
        .setDescription('Cara mengubah')
        .setRequired(true)
        .addChoices(
          { name: '🎯 Set (tentukan angka MMR)', value: 'set' },
          { name: '➕ Tambah', value: 'add' },
          { name: '➖ Kurangi', value: 'sub' }
        )
    )
    .addIntegerOption((o) =>
      o.setName('jumlah').setDescription('Angka MMR (untuk Set: MMR akhir)').setRequired(true).setMinValue(0).setMaxValue(MAX_MMR)
    )
    .addBooleanOption((o) =>
      o.setName('skip_placement').setDescription('Anggap placement role ini selesai, supaya rank langsung tampil')
    )
    .addStringOption((o) => o.setName('alasan').setDescription('Alasan (tercatat di log admin)').setMaxLength(300)),
  async (i) => {
    if (!isMod(i)) return i.reply({ content: '❌ Hanya admin/mod.', flags: EPHEMERAL });
    await i.deferReply({ flags: EPHEMERAL });

    const target = i.options.getUser('player', true);
    const role = i.options.getString('role', true);
    const mode = i.options.getString('mode', true);
    const amount = i.options.getInteger('jumlah', true);
    const reason = i.options.getString('alasan') || '-';
    const skip = i.options.getBoolean('skip_placement') || false;
    const season = getSeason();

    const stat = getStat(target.id, role, season);
    const beforeOv = overall(target.id);
    const old = stat.mmr;

    let next = mode === 'set' ? amount : mode === 'add' ? old + amount : old - amount;
    next = Math.max(0, Math.min(MAX_MMR, next));

    db.transaction(() => {
      db.prepare(
        'UPDATE stats SET mmr=?, peak=MAX(peak,?), games=CASE WHEN ? THEN MAX(games,?) ELSE games END WHERE discord_id=? AND season=? AND role=?'
      ).run(next, next, skip ? 1 : 0, cfg.placementGames, target.id, season, role);
      db.prepare(
        'INSERT INTO mmr_adjustments (discord_id, season, role, mmr_before, mmr_after, reason, by) VALUES (?,?,?,?,?,?,?)'
      ).run(target.id, season, role, old, next, reason, i.user.id);
    })();

    const afterOv = overall(target.id);
    await syncRank(i.client, target.id, afterOv);

    const diff = next - old;
    const sign = diff >= 0 ? '+' : '';
    const roleLabel = role === 'killer' ? '🔪 Killer' : '🏃 Survivor';
    const rankChange =
      overallLabel(beforeOv) !== overallLabel(afterOv) ? `\nRank: ${overallLabel(beforeOv)} ➜ ${overallLabel(afterOv)}` : '';

    const embed = new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle('🛠️ MMR ADJUSTMENT')
      .addFields(
        { name: 'Pemain', value: `<@${target.id}>`, inline: true },
        { name: 'Role', value: roleLabel, inline: true },
        { name: 'MMR', value: `${old} → **${next}** (${sign}${diff})`, inline: true },
        { name: 'Oleh', value: `<@${i.user.id}>`, inline: true },
        { name: 'Placement', value: skip ? `Dilewati (min. ${cfg.placementGames} game)` : 'Tidak diubah', inline: true },
        { name: 'Alasan', value: reason }
      );
    await sendAdmin(i.client, { embeds: [embed], allowedMentions: { parse: [] } });

    return i.editReply({
      content: `✅ MMR ${roleLabel} <@${target.id}>: ${old} → **${next}** (${sign}${diff})${skip ? '\n📌 Placement role ini dianggap selesai.' : ''}${rankChange}`,
      allowedMentions: { parse: [] },
    });
  }
);

// ---------------------------------------------------------------- /party
add(party.data, party.execute);

// ---------------------------------------------------------------- /setup-panel (admin)
add(
  new SlashCommandBuilder()
    .setName('setup-panel')
    .setDescription('Kirim panel Ranked Queue di channel ini')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async (i) => {
    const embed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle('🔥 VDP RANKED')
      .setDescription(
        'Tekan **Join Queue**, lalu tunggu match ditemukan.\n\n' +
          '**Format:** 1 🔪 Killer vs 4 🏃 Survivor\n' +
          '**Role:** diacak otomatis saat match ditemukan 🎲\n' +
          '**Wajib:** akun Roblox terverifikasi (`/verify`)\n' +
          '**Party:** `/party create` → `/party invite` → leader tekan **Party Queue** (party selalu jadi Survivor)\n\n' +
          'Rating Killer & Survivor dihitung **terpisah**. Menang/kalah juga memberi **Ranked Points**.'
      );
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('q:join').setLabel('🎮 Join Queue').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('q:party').setLabel('👥 Party Queue').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('q:leave').setLabel('❌ Leave Queue').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('q:rank').setLabel('📊 My Rank').setStyle(ButtonStyle.Secondary)
    );
    await i.channel.send({ embeds: [embed], components: [row] });
    return i.reply({ content: '✅ Panel dikirim.', flags: EPHEMERAL });
  }
);

// ---------------------------------------------------------------- /season-end (admin)
add(
  new SlashCommandBuilder()
    .setName('season-end')
    .setDescription('Akhiri season: simpan Hall of Fame & mulai season baru')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async (i) => {
    const active = db.prepare("SELECT COUNT(*) AS c FROM matches WHERE status IN ('active','disputed')").get().c;
    if (active) return i.reply({ content: `⚠️ Masih ada ${active} match aktif/dispute. Selesaikan dulu.`, flags: EPHEMERAL });

    const season = getSeason();
    const champs = [
      ['👑 Champion', topRows('overall', season, 1)[0]],
      ['🔪 Killer Champion', topRows('killer', season, 1)[0]],
      ['🏃 Survivor Champion', topRows('survivor', season, 1)[0]],
    ];
    const ins = db.prepare('INSERT INTO hall_of_fame (season, title, discord_id, mmr) VALUES (?,?,?,?)');
    champs.forEach(([title, row]) => row && ins.run(season, title, row.discord_id, row.mmr));
    setSeason(season + 1);

    const lines = champs.map(([title, row]) => (row ? `${title}: <@${row.discord_id}> — ${row.mmr} MMR` : `${title}: -`));
    const embed = new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle(`🏆 SEASON ${String(season).padStart(2, '0')} COMPLETE`)
      .setDescription(`${lines.join('\n')}\n\nSeason ${season + 1} dimulai. MMR di-soft reset ke tengah, RP season kembali 0 (total RP tetap tersimpan).`);
    return i.reply({ embeds: [embed] });
  }
);

// ---------------------------------------------------------------- /hall-of-fame
add(new SlashCommandBuilder().setName('hall-of-fame').setDescription('Juara semua season'), async (i) => {
  const rows = db.prepare('SELECT * FROM hall_of_fame ORDER BY season DESC, rowid').all();
  if (!rows.length) return i.reply({ content: 'Belum ada season yang selesai.', flags: EPHEMERAL });

  const bySeason = new Map();
  rows.forEach((r) => {
    if (!bySeason.has(r.season)) bySeason.set(r.season, []);
    bySeason.get(r.season).push(`${r.title} — <@${r.discord_id}> (${r.mmr})`);
  });
  const text = [...bySeason.entries()].map(([s, l]) => `**SEASON ${String(s).padStart(2, '0')}**\n${l.join('\n')}`).join('\n\n');
  const embed = new EmbedBuilder().setColor(0xf1c40f).setTitle('💀 VD RANKED HALL OF FAME').setDescription(text);
  return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
});

module.exports = { commands, handleVerifyConfirm };
