const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} = require('discord.js');
const cfg = require('./config');
const { db, removeFromQueue, isFrozen } = require('./db');

const EPHEMERAL = MessageFlags.Ephemeral;

// ------------------------------------------------------------------ data helpers
function getPartyOf(userId) {
  return (
    db
      .prepare('SELECT p.* FROM parties p JOIN party_members pm ON pm.party_id = p.id WHERE pm.discord_id=?')
      .get(userId) || null
  );
}

function getParty(partyId) {
  return db.prepare('SELECT * FROM parties WHERE id=?').get(partyId) || null;
}

function members(partyId) {
  return db
    .prepare('SELECT discord_id FROM party_members WHERE party_id=? ORDER BY joined_at, rowid')
    .all(partyId)
    .map((r) => r.discord_id);
}

function isPartyQueued(partyId) {
  return Boolean(db.prepare('SELECT 1 FROM queue WHERE party_id=?').get(partyId));
}

function createParty(leaderId) {
  return db.transaction(() => {
    const r = db.prepare('INSERT INTO parties (leader_id) VALUES (?)').run(leaderId);
    const id = Number(r.lastInsertRowid);
    db.prepare('INSERT INTO party_members (discord_id, party_id) VALUES (?,?)').run(leaderId, id);
    return id;
  })();
}

function disbandParty(partyId) {
  db.transaction(() => {
    db.prepare('DELETE FROM queue WHERE party_id=?').run(partyId);
    db.prepare('DELETE FROM party_members WHERE party_id=?').run(partyId);
    db.prepare('DELETE FROM parties WHERE id=?').run(partyId);
  })();
}

// Keluar dari party. Kalau leader keluar, kepemimpinan pindah; kalau tinggal 1 orang, party bubar.
function leaveParty(userId) {
  const party = getPartyOf(userId);
  if (!party) return { left: false };

  removeFromQueue(userId); // kalau party sedang antre, batalkan antrean

  db.prepare('DELETE FROM party_members WHERE discord_id=?').run(userId);
  const rest = members(party.id);
  if (rest.length <= 1) {
    disbandParty(party.id);
    return { left: true, disbanded: true, party };
  }
  if (party.leader_id === userId) {
    db.prepare('UPDATE parties SET leader_id=? WHERE id=?').run(rest[0], party.id);
    return { left: true, disbanded: false, newLeader: rest[0], party };
  }
  return { left: true, disbanded: false, party };
}

// ------------------------------------------------------------------ /party
const data = new SlashCommandBuilder()
  .setName('party')
  .setDescription('Party / Duo queue (khusus sisi Survivor)')
  .addSubcommand((s) => s.setName('create').setDescription('Buat party baru'))
  .addSubcommand((s) =>
    s
      .setName('invite')
      .setDescription('Undang pemain ke party')
      .addUserOption((o) => o.setName('player').setDescription('Pemain yang diundang').setRequired(true))
  )
  .addSubcommand((s) => s.setName('info').setDescription('Lihat anggota party kamu'))
  .addSubcommand((s) => s.setName('leave').setDescription('Keluar dari party'))
  .addSubcommand((s) => s.setName('disband').setDescription('Bubarkan party (leader saja)'));

async function execute(i) {
  const sub = i.options.getSubcommand();
  const uid = i.user.id;

  if (sub === 'create') {
    if (getPartyOf(uid)) return i.reply({ content: '⚠️ Kamu sudah ada di party. Pakai `/party leave` dulu.', flags: EPHEMERAL });
    createParty(uid);
    return i.reply({
      content: `👥 Party dibuat! Undang teman dengan \`/party invite\` (maks ${cfg.maxPartySize} orang), lalu tekan **👥 Party Queue** di panel.`,
      flags: EPHEMERAL,
    });
  }

  if (sub === 'invite') {
    const target = i.options.getUser('player', true);
    if (target.bot || target.id === uid) return i.reply({ content: '❌ Target tidak valid.', flags: EPHEMERAL });

    let party = getPartyOf(uid);
    if (!party) party = getParty(createParty(uid)); // otomatis buat party kalau belum punya
    if (party.leader_id !== uid) return i.reply({ content: '❌ Hanya leader party yang bisa mengundang.', flags: EPHEMERAL });
    if (isPartyQueued(party.id)) return i.reply({ content: '⚠️ Party sedang antre. Keluar dari queue dulu.', flags: EPHEMERAL });
    if (members(party.id).length >= cfg.maxPartySize) {
      return i.reply({ content: `⚠️ Party sudah penuh (${cfg.maxPartySize}).`, flags: EPHEMERAL });
    }
    if (getPartyOf(target.id)) return i.reply({ content: '⚠️ Pemain itu sudah ada di party lain.', flags: EPHEMERAL });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`p:accept:${party.id}:${target.id}`).setLabel('✅ Terima').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`p:decline:${party.id}:${target.id}`).setLabel('❌ Tolak').setStyle(ButtonStyle.Secondary)
    );
    return i.reply({
      content: `👥 <@${target.id}>, kamu diundang ke party oleh <@${uid}>!`,
      components: [row],
      allowedMentions: { users: [target.id] },
    });
  }

  if (sub === 'info') {
    const party = getPartyOf(uid);
    if (!party) return i.reply({ content: 'Kamu tidak sedang di party. Buat dengan `/party create`.', flags: EPHEMERAL });
    const list = members(party.id)
      .map((id) => `${id === party.leader_id ? '👑' : '•'} <@${id}>`)
      .join('\n');
    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle(`👥 Party (${members(party.id).length}/${cfg.maxPartySize})`)
      .setDescription(list)
      .setFooter({ text: isPartyQueued(party.id) ? '🔎 Sedang antre sebagai Survivor' : 'Belum antre' });
    return i.reply({ embeds: [embed], flags: EPHEMERAL, allowedMentions: { parse: [] } });
  }

  if (sub === 'leave') {
    const r = leaveParty(uid);
    if (!r.left) return i.reply({ content: 'Kamu tidak sedang di party.', flags: EPHEMERAL });
    const msg = r.disbanded
      ? '👋 Kamu keluar. Party bubar karena tinggal 1 orang.'
      : r.newLeader
        ? `👋 Kamu keluar. Leader baru: <@${r.newLeader}>.`
        : '👋 Kamu keluar dari party.';
    return i.reply({ content: msg, flags: EPHEMERAL, allowedMentions: { parse: [] } });
  }

  if (sub === 'disband') {
    const party = getPartyOf(uid);
    if (!party) return i.reply({ content: 'Kamu tidak sedang di party.', flags: EPHEMERAL });
    if (party.leader_id !== uid) return i.reply({ content: '❌ Hanya leader yang bisa membubarkan party.', flags: EPHEMERAL });
    disbandParty(party.id);
    return i.reply({ content: '🗑️ Party dibubarkan.', flags: EPHEMERAL });
  }
}

// ------------------------------------------------------------------ tombol undangan: p:accept|decline:<partyId>:<userId>
async function handlePartyButton(i, action, partyId, targetId) {
  if (i.user.id !== targetId) {
    return i.reply({ content: '❌ Undangan ini bukan untukmu.', flags: EPHEMERAL });
  }
  const pid = Number(partyId);

  if (action === 'decline') {
    return i.update({ content: `❌ <@${targetId}> menolak undangan party.`, components: [], allowedMentions: { parse: [] } });
  }

  const party = getParty(pid);
  if (!party) return i.update({ content: '⚠️ Party sudah tidak ada.', components: [] });
  if (getPartyOf(targetId)) return i.update({ content: '⚠️ Kamu sudah ada di party lain.', components: [] });
  if (isPartyQueued(pid)) return i.update({ content: '⚠️ Party sedang antre, undangan kedaluwarsa.', components: [] });
  if (members(pid).length >= cfg.maxPartySize) return i.update({ content: '⚠️ Party sudah penuh.', components: [] });
  if (isFrozen(targetId)) return i.update({ content: '🧊 Akunmu sedang dibekukan, tidak bisa bergabung party.', components: [] });

  db.prepare('INSERT INTO party_members (discord_id, party_id) VALUES (?,?)').run(targetId, pid);
  return i.update({
    content: `✅ <@${targetId}> bergabung ke party <@${party.leader_id}> (${members(pid).length}/${cfg.maxPartySize}).`,
    components: [],
    allowedMentions: { parse: [] },
  });
}

module.exports = {
  data,
  execute,
  handlePartyButton,
  getPartyOf,
  getParty,
  members,
  isPartyQueued,
};
