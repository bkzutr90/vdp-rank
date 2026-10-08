const {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');
const cfg = require('./config');
const { db, matchTag, nowSec, getSeason, getStat, isFrozen, removeFromQueue } = require('./db');
const { profileUrl } = require('./roblox');
const { resultButtons } = require('./matches');
const { rankEmbed } = require('./embeds');
const { getPartyOf, members, isPartyQueued } = require('./party');

let running = false;

// Kelompokkan antrean survivor menjadi unit: solo (1 orang) atau party (2-4 orang)
function buildUnits(rows) {
  const units = [];
  const byParty = new Map();

  for (const r of rows) {
    const row = { ...r, mmr: getStat(r.discord_id, 'survivor').mmr };
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

function findMatch() {
  const killers = db.prepare("SELECT * FROM queue WHERE role='killer' ORDER BY joined_at").all();
  const survRows = db.prepare("SELECT * FROM queue WHERE role='survivor' ORDER BY joined_at").all();
  const slots = cfg.survivorsPerMatch;
  if (!killers.length || survRows.length < slots) return null;

  const units = buildUnits(survRows);
  const parties = units.filter((u) => u.size > 1);
  const now = nowSec();

  for (const k of killers) {
    const kMmr = getStat(k.discord_id, 'killer').mmr;
    const dist = (u) => Math.abs(u.mmr - kMmr);
    const solos = units.filter((u) => u.size === 1).sort((a, b) => dist(a) - dist(b));

    // Kandidat susunan survivor. Aturan fairness: maksimal 1 party per match.
    const options = [];
    if (solos.length >= slots) options.push(solos.slice(0, slots));
    for (const p of parties) {
      if (p.size > slots) continue;
      const need = slots - p.size;
      if (solos.length >= need) options.push([p, ...solos.slice(0, need)]);
    }

    // Prioritas FIFO: susunan yang berisi antrean paling lama dicoba duluan
    const scored = options
      .map((opt) => ({
        opt,
        age: Math.min(...opt.map((u) => u.joined)),
        farthest: Math.max(...opt.map(dist)),
        maxWait: Math.max(now - k.joined_at, ...opt.map((u) => now - u.joined)),
      }))
      .sort((a, b) => a.age - b.age);

    for (const s of scored) {
      const range = Math.min(cfg.maxRange, cfg.baseRange + cfg.rangePerSecond * s.maxWait);
      if (s.farthest <= range) return { killer: k, survivors: s.opt.flatMap((u) => u.rows) };
    }
  }
  return null;
}

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

  try {
    const guild = await client.guilds.fetch(cfg.guildId);
    const allow = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.ReadMessageHistory,
    ];
    const overwrites = [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      ...ids.map((id) => ({ id, allow })),
    ];
    if (cfg.modRoleId) overwrites.push({ id: cfg.modRoleId, allow });

    const channel = await guild.channels.create({
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
    db.prepare("UPDATE matches SET status='void' WHERE id=?").run(matchId);
    const re = db.prepare('INSERT OR REPLACE INTO queue (discord_id, role, party_id, joined_at) VALUES (?,?,?,?)');
    all.forEach((p) => re.run(p.discord_id, p.role, p.party_id || null, p.joined_at));
  }
}

async function runMatchmaking(client) {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const found = findMatch();
      if (!found) break;
      await createMatch(client, found.killer, found.survivors);
    }
  } catch (err) {
    console.error('[matchmaking] error:', err);
  } finally {
    running = false;
  }
}

function queueCounts() {
  const k = db.prepare("SELECT COUNT(*) AS c FROM queue WHERE role='killer'").get().c;
  const s = db.prepare("SELECT COUNT(*) AS c FROM queue WHERE role='survivor'").get().c;
  return { k, s };
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

// Tombol panel: q:killer | q:survivor | q:party | q:leave | q:rank
async function handleQueueButton(interaction, action, client) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const id = interaction.user.id;

  if (action === 'rank') {
    return interaction.editReply({ embeds: [rankEmbed(interaction.user)] });
  }

  if (action === 'leave') {
    const n = removeFromQueue(id);
    return interaction.editReply(n > 1 ? '✅ Party kamu keluar dari queue.' : n ? '✅ Kamu keluar dari queue.' : 'Kamu tidak sedang di queue.');
  }

  // ---------------- Party queue (sisi Survivor)
  if (action === 'party') {
    const party = getPartyOf(id);
    if (!party) return interaction.editReply('👥 Kamu belum punya party. Buat dengan `/party create` lalu `/party invite`.');
    if (party.leader_id !== id) return interaction.editReply('❌ Hanya **leader** party yang bisa memulai Party Queue.');

    const mem = members(party.id);
    if (mem.length < 2) return interaction.editReply('👥 Party butuh minimal 2 orang. Undang teman dengan `/party invite`.');
    if (isPartyQueued(party.id)) return interaction.editReply('🔎 Party kamu sudah di queue.');

    for (const m of mem) {
      const err = eligibilityError(m);
      if (err) return interaction.editReply(`⚠️ <@${m}> ${err}`);
    }

    const now = nowSec();
    db.transaction(() => {
      mem.forEach((m) => removeFromQueue(m));
      const ins = db.prepare("INSERT INTO queue (discord_id, role, party_id, joined_at) VALUES (?, 'survivor', ?, ?)");
      mem.forEach((m) => ins.run(m, party.id, now));
    })();

    await runMatchmaking(client);

    if (!db.prepare('SELECT 1 FROM queue WHERE discord_id=?').get(id)) {
      return interaction.editReply('🔥 **Match ditemukan!** Cek channel lobby baru untuk party kamu.');
    }
    const { k, s } = queueCounts();
    return interaction.editReply(
      `🔎 Party (${mem.length} orang) searching sebagai **🏃 Survivor**...\n` +
        `Queue: 🔪 ${k} Killer • 🏃 ${s} Survivor. Maksimal 1 party per match.`
    );
  }

  // ---------------- Solo queue
  if (action !== 'killer' && action !== 'survivor') return interaction.editReply('Aksi tidak dikenal.');

  if (getPartyOf(id)) {
    return interaction.editReply('👥 Kamu sedang di party. Pakai **Party Queue** (leader), atau keluar dulu dengan `/party leave` untuk antre solo.');
  }

  const err = eligibilityError(id);
  if (err) return interaction.editReply(`❌ Kamu ${err}`);

  removeFromQueue(id);
  db.prepare('INSERT INTO queue (discord_id, role, joined_at) VALUES (?,?,?)').run(id, action, nowSec());

  await runMatchmaking(client);

  if (!db.prepare('SELECT 1 FROM queue WHERE discord_id=?').get(id)) {
    return interaction.editReply('🔥 **Match ditemukan!** Cek channel lobby baru untukmu.');
  }

  const { k, s } = queueCounts();
  return interaction.editReply(
    `🔎 Searching for match sebagai **${action === 'killer' ? '🔪 Killer' : '🏃 Survivor'}**...\n` +
      `Queue: 🔪 ${k} Killer • 🏃 ${s} Survivor (butuh 1 Killer + ${cfg.survivorsPerMatch} Survivor)`
  );
}

module.exports = { runMatchmaking, handleQueueButton };
