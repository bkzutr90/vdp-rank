const {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits,
} = require('discord.js');
const cfg = require('./config');
const { db, matchTag, nowSec, getSeason, overall, isFrozen, removeFromQueue } = require('./db');
const { profileUrl } = require('./roblox');
const { resultButtons, sendAdmin } = require('./matches');
const { rankPayload } = require('./embeds');
const { getPartyOf, members, isPartyQueued } = require('./party');

let running = false;

// Kalau pembuatan lobby gagal (izin bot kurang, kategori penuh, dll.), matchmaking dijeda
// dan tidak mengulang terus-menerus. Jeda memanjang tiap gagal berturut-turut (maks 10 menit).
let pausedUntil = 0;
let failStreak = 0;
const PAUSE_BASE_MS = 60 * 1000;
const PAUSE_MAX_MS = 10 * 60 * 1000;

// Berapa banyak "match sejak terakhir jadi Killer" yang dihitung sebagai bobot (maks).
// Makin lama tidak jadi Killer, makin besar peluang kepilih, tapi tetap acak.
const KILLER_WEIGHT_CAP = 6;

// ------------------------------------------------------------------ pembentukan unit antrean
// Unit = solo (1 orang) atau party (2-4 orang). MMR memakai MMR keseluruhan karena role belum diketahui.
function buildUnits(rows) {
  const units = [];
  const byParty = new Map();

  for (const r of rows) {
    const row = { ...r, mmr: overall(r.discord_id).mmr };
    if (r.party_id) {
      if (!byParty.has(r.party_id)) byParty.set(r.party_id, []);
      byParty.get(r.party_id).push(row);
    } else {
      units.push({ rows: [row], size: 1, mmr: row.mmr, joined: r.joined_at });
    }
  }
  for (const list of byParty.values()) {
    const avg = list.reduce((a, x) => a + x.mmr, 0) / list.length;
    units.push({
      rows: list,
      size: list.length,
      // party dianggap sedikit lebih kuat karena komunikasi
      mmr: avg + (list.length - 1) * cfg.partyMmrBonus,
      joined: Math.min(...list.map((x) => x.joined_at)),
    });
  }
  return units;
}

// ------------------------------------------------------------------ pemilihan Killer (acak berbobot)
function killerWeight(id) {
  const last =
    db
      .prepare(
        `SELECT MAX(mp.match_id) AS id FROM match_players mp JOIN matches m ON m.id = mp.match_id
         WHERE mp.discord_id=? AND mp.role='killer' AND m.status != 'void'`
      )
      .get(id).id || 0;
  const since = db
    .prepare(
      `SELECT COUNT(*) AS c FROM match_players mp JOIN matches m ON m.id = mp.match_id
       WHERE mp.discord_id=? AND mp.match_id > ? AND m.status != 'void'`
    )
    .get(id, last).c;
  return 1 + Math.min(since, KILLER_WEIGHT_CAP);
}

// Hanya pemain solo yang bisa jadi Killer (party selalu di sisi Survivor)
function pickKiller(candidates) {
  const weights = candidates.map((p) => killerWeight(p.discord_id));
  let roll = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i];
    if (roll < 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

// ------------------------------------------------------------------ cari match
function findMatch() {
  const rows = db.prepare('SELECT * FROM queue ORDER BY joined_at').all();
  const total = cfg.survivorsPerMatch + 1; // 5 pemain
  if (rows.length < total) return null;

  const units = buildUnits(rows).sort((a, b) => a.joined - b.joined); // FIFO: yang paling lama jadi patokan
  const now = nowSec();

  for (const anchor of units) {
    const dist = (u) => Math.abs(u.mmr - anchor.mmr);
    const others = units.filter((u) => u !== anchor).sort((a, b) => dist(a) - dist(b));
    const solos = others.filter((u) => u.size === 1);
    const parties = others.filter((u) => u.size > 1 && u.size <= total - 1);

    // Susunan lobby berisi total pemain. Aturan: maksimal 1 party per match, dan minimal 1 solo (calon Killer).
    const options = [];
    if (anchor.size === 1) {
      if (solos.length >= total - 1) options.push([anchor, ...solos.slice(0, total - 1)]);
      for (const p of parties) {
        const need = total - 1 - p.size;
        if (solos.length >= need) options.push([anchor, p, ...solos.slice(0, need)]);
      }
    } else if (anchor.size <= total - 1) {
      const need = total - anchor.size;
      if (solos.length >= need) options.push([anchor, ...solos.slice(0, need)]);
    }

    const valid = options
      .map((opt) => {
        const farthest = Math.max(...opt.map(dist));
        const maxWait = Math.max(...opt.map((u) => now - u.joined));
        const range = Math.min(cfg.maxRange, cfg.baseRange + cfg.rangePerSecond * maxWait);
        return { opt, farthest, ok: farthest <= range };
      })
      .filter((x) => x.ok)
      .sort((a, b) => a.farthest - b.farthest);

    if (valid.length) {
      const players = valid[0].opt.flatMap((u) => u.rows);
      const killer = pickKiller(players.filter((p) => !p.party_id));
      const survivors = players.filter((p) => p !== killer);
      return { killer, survivors };
    }
  }
  return null;
}

// ------------------------------------------------------------------ buat match + lobby
async function createMatch(client, killer, survivors) {
  const season = getSeason();
  const all = [killer, ...survivors];
  const ids = all.map((p) => p.discord_id);

  const matchId = db.transaction(() => {
    const r = db.prepare("INSERT INTO matches (season,status,killer_id) VALUES (?, 'active', ?)").run(season, killer.discord_id);
    const id = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO match_players (match_id,discord_id,role) VALUES (?,?,?)');
    ins.run(id, killer.discord_id, 'killer');
    survivors.forEach((s) => ins.run(id, s.discord_id, 'survivor'));
    db.prepare(`DELETE FROM queue WHERE discord_id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    return id;
  })();

  let channel = null;
  try {
    const guild = await client.guilds.fetch(cfg.guildId);
    const allow = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.ReadMessageHistory,
    ];
    // `type` wajib disebut eksplisit: tanpa itu discord.js mencari ID di cache dan gagal
    // ("not a cached User or Role") untuk pemain yang belum ada di cache bot.
    const overwrites = [
      { id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
      // Bot harus punya akses eksplisit, karena deny @everyone juga mencabut akses lihat channel dari bot
      {
        id: client.user.id,
        type: OverwriteType.Member,
        allow: [...allow, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageChannels],
      },
      ...ids.map((id) => ({ id, type: OverwriteType.Member, allow })),
    ];
    if (cfg.modRoleId) overwrites.push({ id: cfg.modRoleId, type: OverwriteType.Role, allow });

    channel = await guild.channels.create({
      name: `match-${String(matchId).padStart(6, '0')}`,
      type: ChannelType.GuildText,
      parent: cfg.categoryId || undefined,
      permissionOverwrites: overwrites,
      reason: `VDP Ranked ${matchTag(matchId)}`,
    });
    db.prepare('UPDATE matches SET channel_id=? WHERE id=?').run(channel.id, matchId);

    const fmt = (p) => {
      const r = db.prepare('SELECT roblox_id, roblox_name FROM users WHERE discord_id=?').get(p.discord_id);
      const party = p.party_id ? ' 👥' : '';
      return r ? `<@${p.discord_id}> — [${r.roblox_name}](${profileUrl(r.roblox_id)})${party}` : `<@${p.discord_id}>${party}`;
    };

    const hasParty = survivors.some((s) => s.party_id);
    const embed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle(`🔥 ${matchTag(matchId)} — MATCH FOUND`)
      .setDescription('🎲 Role dibagikan secara acak.')
      .addFields(
        { name: '🔪 Killer', value: fmt(killer) },
        { name: `🏃 Survivors${hasParty ? ' (👥 = party)' : ''}`, value: survivors.map(fmt).join('\n') },
        {
          name: '📋 Langkah',
          value:
            '1. **Killer** buat private server Violence District & kirim link di sini.\n' +
            '2. Semua pemain join dan main sampai selesai.\n' +
            '3. Upload **screenshot** hasil akhir di channel ini.\n' +
            `4. Tiap pemain tekan tombol pemenang. Hasil sah jika **${cfg.votesNeeded} dari ${cfg.survivorsPerMatch + 1}** pemain sepakat.\n` +
            `5. Match tanpa hasil dalam **${cfg.matchTimeoutMin} menit** otomatis di-void / dispute.`,
        }
      )
      .setFooter({ text: 'Hanya 5 pemain di match ini yang bisa submit hasil.' });

    await channel.send({
      content: ids.map((id) => `<@${id}>`).join(' '),
      embeds: [embed],
      components: [resultButtons(matchId)],
    });
  } catch (err) {
    console.error('[matchmaking] gagal bikin lobby, match di-void & pemain dikembalikan ke queue:', err);
    // Hapus channel setengah jadi supaya tidak menumpuk
    if (channel) await channel.delete('Gagal membuat lobby').catch(() => {});
    db.prepare("UPDATE matches SET status='void', channel_id=NULL, finished_at=strftime('%s','now') WHERE id=?").run(matchId);
    const re = db.prepare('INSERT OR REPLACE INTO queue (discord_id, role, party_id, joined_at) VALUES (?,?,?,?)');
    all.forEach((p) => re.run(p.discord_id, p.role, p.party_id || null, p.joined_at));
    return { ok: false, error: err };
  }
  return { ok: true };
}

async function runMatchmaking(client) {
  if (running) return;
  if (Date.now() < pausedUntil) return;
  running = true;
  try {
    for (;;) {
      const found = findMatch();
      if (!found) break;

      const res = await createMatch(client, found.killer, found.survivors);
      if (res.ok) {
        failStreak = 0;
        continue;
      }

      // Gagal: berhenti, jeda, dan kabari admin (jangan diulang terus)
      failStreak += 1;
      const pauseMs = Math.min(PAUSE_BASE_MS * failStreak, PAUSE_MAX_MS);
      pausedUntil = Date.now() + pauseMs;
      await sendAdmin(client, {
        content:
          `⚠️ **Gagal membuat lobby match.** Matchmaking dijeda ${Math.round(pauseMs / 1000)} detik ` +
          `(gagal berturut-turut: ${failStreak}).\n` +
          `Error: \`${String(res.error?.message || res.error).slice(0, 300)}\`\n` +
          'Cek izin bot (Manage Channels, Manage Roles, View Channels) dan jumlah channel di kategori match (maks. 50).',
      });
      break;
    }
  } catch (err) {
    console.error('[matchmaking] error:', err);
  } finally {
    running = false;
  }
}

function queueCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM queue').get().c;
}

// Mengembalikan pesan error (string) atau null kalau pemain boleh antre
function eligibilityError(id) {
  if (cfg.requireVerify && !db.prepare('SELECT 1 FROM users WHERE discord_id=?').get(id)) {
    return 'belum verifikasi akun Roblox (`/verify`).';
  }
  if (isFrozen(id)) return '🧊 MMR sedang dibekukan admin, tidak bisa antre.';
  const active = db
    .prepare(
      `SELECT m.id FROM matches m JOIN match_players p ON p.match_id = m.id
       WHERE p.discord_id=? AND m.status IN ('active','disputed')`
    )
    .get(id);
  if (active) return `masih punya match aktif: **${matchTag(active.id)}**.`;
  return null;
}

// Tombol panel: q:join | q:party | q:leave | q:rank
// (q:killer & q:survivor dari panel lama otomatis dianggap q:join)
async function handleQueueButton(interaction, action, client) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const id = interaction.user.id;
  const need = cfg.survivorsPerMatch + 1;

  if (action === 'rank') {
    return interaction.editReply(rankPayload(interaction.user));
  }

  if (action === 'leave') {
    const n = removeFromQueue(id);
    return interaction.editReply(n > 1 ? '✅ Party kamu keluar dari queue.' : n ? '✅ Kamu keluar dari queue.' : 'Kamu tidak sedang di queue.');
  }

  // ---------------- Party queue (selalu di sisi Survivor)
  if (action === 'party') {
    const party = getPartyOf(id);
    if (!party) return interaction.editReply('👥 Kamu belum punya party. Buat dengan `/party create` lalu `/party invite`.');
    if (party.leader_id !== id) return interaction.editReply('❌ Hanya **leader** party yang bisa memulai Party Queue.');

    const mem = members(party.id);
    if (mem.length < 2) return interaction.editReply('👥 Party butuh minimal 2 orang. Undang teman dengan `/party invite`.');
    if (mem.length >= need) return interaction.editReply(`👥 Party maksimal ${need - 1} orang karena harus ada minimal 1 pemain solo (calon Killer).`);
    if (isPartyQueued(party.id)) return interaction.editReply('🔎 Party kamu sudah di queue.');

    for (const m of mem) {
      const err = eligibilityError(m);
      if (err) return interaction.editReply(`⚠️ <@${m}> ${err}`);
    }

    const now = nowSec();
    db.transaction(() => {
      mem.forEach((m) => removeFromQueue(m));
      const ins = db.prepare("INSERT INTO queue (discord_id, role, party_id, joined_at) VALUES (?, 'party', ?, ?)");
      mem.forEach((m) => ins.run(m, party.id, now));
    })();

    await runMatchmaking(client);

    if (!db.prepare('SELECT 1 FROM queue WHERE discord_id=?').get(id)) {
      return interaction.editReply('🔥 **Match ditemukan!** Cek channel lobby baru untuk party kamu.');
    }
    return interaction.editReply(
      `🔎 Party (${mem.length} orang) searching sebagai **🏃 Survivor**...\n` +
        `Queue: ${queueCount()} pemain (butuh ${need}). Maksimal 1 party per match.`
    );
  }

  // ---------------- Solo queue (role diacak saat match ditemukan)
  if (action !== 'join' && action !== 'killer' && action !== 'survivor') return interaction.editReply('Aksi tidak dikenal.');

  if (getPartyOf(id)) {
    return interaction.editReply('👥 Kamu sedang di party. Pakai **Party Queue** (leader), atau keluar dulu dengan `/party leave` untuk antre solo.');
  }

  const err = eligibilityError(id);
  if (err) return interaction.editReply(`❌ Kamu ${err}`);

  removeFromQueue(id);
  db.prepare("INSERT INTO queue (discord_id, role, joined_at) VALUES (?, 'any', ?)").run(id, nowSec());

  await runMatchmaking(client);

  if (!db.prepare('SELECT 1 FROM queue WHERE discord_id=?').get(id)) {
    return interaction.editReply('🔥 **Match ditemukan!** Cek channel lobby baru untukmu. Role kamu sudah diacak di sana.');
  }

  return interaction.editReply(
    `🔎 Searching for match...\n` +
      `Queue: ${queueCount()} pemain (butuh ${need}). 🎲 Role (🔪 Killer / 🏃 Survivor) diacak saat match ditemukan.`
  );
}

module.exports = { runMatchmaking, handleQueueButton };
