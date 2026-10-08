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
const { db, getSeason, setSeason, setFrozen, clearFrozen, isFrozen, nowSec } = require('./db');
const { lookupUser, getDescription, profileUrl } = require('./roblox');
const { rankEmbed } = require('./embeds');
const { sendAdmin, freezeRow, isMod } = require('./matches');
const party = require('./party');

const EPHEMERAL = MessageFlags.Ephemeral;
const MEDALS = ['🥇', '🥈', '🥉'];
const WINDOWS = { weekly: 7, monthly: 30 };
const REPORT_CATEGORIES = [
  ['🚫 Cheating', 'Cheating'],
  ['🚫 Exploiting', 'Exploiting'],
  ['🚫 Boosting', 'Boosting'],
  ['🚫 Win Trading', 'Win Trading'],
  ['🚫 Toxicity', 'Toxicity'],
  ['🚫 Match Manipulation', 'Match Manipulation'],
  ['🚫 Fake Result', 'Fake Result'],
];

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
    return i.reply({ embeds: [rankEmbed(user)] });
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
  return topRows(kind, season, 10).map((r) => ({ discord_id: r.discord_id, text: `${r.mmr} MMR` }));
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

    const body = rows.length
      ? rows.map((r, idx) => `${MEDALS[idx] || `**${idx + 1}.**`} <@${r.discord_id}> — ${r.text}`).join('\n')
      : period === 'season'
        ? 'Belum ada data untuk leaderboard ini.'
        : 'Belum ada pemain dengan minimal 3 match di periode ini.';

    const embed = new EmbedBuilder().setColor(0xf1c40f).setTitle(`${kindTitle} — ${periodTitle}`).setDescription(body);
    if (period !== 'season') {
      embed.setFooter({
        text: `${WINDOWS[period]} hari terakhir • diurutkan dari ${kind === 'rp' ? 'RP' : 'MMR'} yang didapat • minimal 3 match`,
      });
    }
    return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
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
        'Pilih role, lalu tunggu match ditemukan.\n\n' +
          '**Format:** 1 🔪 Killer vs 4 🏃 Survivor\n' +
          '**Wajib:** akun Roblox terverifikasi (`/verify`)\n' +
          '**Party:** `/party create` → `/party invite` → leader tekan **Party Queue** (sisi Survivor)\n\n' +
          'Rating Killer & Survivor dihitung **terpisah**. Menang/kalah juga memberi **Ranked Points**.'
      );
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('q:killer').setLabel('🔪 Join Killer').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('q:survivor').setLabel('🏃 Join Survivor').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('q:party').setLabel('👥 Party Queue').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('q:leave').setLabel('❌ Leave Queue').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('q:rank').setLabel('📊 My Rank').setStyle(ButtonStyle.Primary)
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
