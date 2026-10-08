const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');
const cfg = require('./config');
const { db, matchTag, nowSec, finalizeMatch, overall, setFrozen, clearFrozen, shouldAlert } = require('./db');
const { getRank } = require('./ranks');
const { syncRank } = require('./roles');
const { overallLabel } = require('./embeds');
const { renderRankCard } = require('./rankcard');

const EPHEMERAL = MessageFlags.Ephemeral;

// ------------------------------------------------------------------ komponen
function resultButtons(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`r:killer:${id}`).setLabel('🔪 Killer Menang').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`r:survivor:${id}`).setLabel('🏃 Survivor Menang').setStyle(ButtonStyle.Success)
  );
}

function adminButtons(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`a:killer:${id}`).setLabel('✅ Killer Menang').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`a:survivor:${id}`).setLabel('✅ Survivor Menang').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`a:void:${id}`).setLabel('🗑️ Void Match').setStyle(ButtonStyle.Secondary)
  );
}

// Tombol Freeze MMR untuk beberapa pemain: [{id, name}]
function freezeRow(targets) {
  return new ActionRowBuilder().addComponents(
    targets.slice(0, 5).map((t) =>
      new ButtonBuilder()
        .setCustomId(`f:freeze:${t.id}`)
        .setLabel(`🧊 Freeze ${String(t.name).slice(0, 28)}`)
        .setStyle(ButtonStyle.Primary)
    )
  );
}

function isMod(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  return Boolean(cfg.modRoleId && interaction.member?.roles?.cache?.has(cfg.modRoleId));
}

async function sendAdmin(client, payload) {
  if (!cfg.adminChannelId) {
    console.warn('[admin] ADMIN_CHANNEL_ID belum diisi, alert tidak terkirim');
    return null;
  }
  try {
    const ch = await client.channels.fetch(cfg.adminChannelId);
    return await ch.send(payload);
  } catch (err) {
    console.warn('[admin] gagal kirim alert:', err.message);
    return null;
  }
}

async function nameOf(client, id) {
  const u = await client.users.fetch(id).catch(() => null);
  return u ? u.username : id;
}

async function lobbyOf(client, matchId) {
  const m = db.prepare('SELECT channel_id FROM matches WHERE id=?').get(matchId);
  if (!m?.channel_id) return null;
  return client.channels.fetch(m.channel_id).catch(() => null);
}

// ------------------------------------------------------------------ alert admin
async function disputeAlert(client, matchId, reason) {
  const m = db.prepare('SELECT * FROM matches WHERE id=?').get(matchId);
  const votes = db.prepare('SELECT vote, COUNT(*) AS c FROM match_players WHERE match_id=? AND vote IS NOT NULL GROUP BY vote').all(matchId);
  const tally = votes.length ? votes.map((v) => `${v.vote}: ${v.c}`).join(' • ') : 'belum ada vote';

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('🚨 RANKED ALERT')
    .setDescription(`**${matchTag(matchId)}**\n⚠️ ${reason}`)
    .addFields(
      { name: 'Vote', value: tally, inline: true },
      { name: 'Lobby', value: m?.channel_id ? `<#${m.channel_id}>` : '-', inline: true }
    )
    .setFooter({ text: 'Cek screenshot/bukti di channel lobby, lalu pilih hasil.' });

  await sendAdmin(client, { embeds: [embed], components: [adminButtons(matchId)] });
}

// Pola mencurigakan #1: 5 menang beruntun melawan lawan jauh lebih lemah
async function checkSuspicious(client, results) {
  for (const r of results.filter((x) => x.won && !x.frozen)) {
    const rows = db
      .prepare(
        `SELECT mp.role, m.winner, m.killer_mmr, m.surv_avg
         FROM match_players mp JOIN matches m ON m.id = mp.match_id
         WHERE mp.discord_id=? AND m.status='verified'
         ORDER BY m.id DESC LIMIT 5`
      )
      .all(r.discord_id);
    if (rows.length < 5) continue;
    if (!rows.every((x) => x.winner === x.role)) continue;

    const avgOpp = rows.reduce((a, x) => a + (x.role === 'killer' ? x.surv_avg : x.killer_mmr), 0) / rows.length;
    const mine = overall(r.discord_id).mmr;
    if (avgOpp < mine - 300 && shouldAlert(`sus:${r.discord_id}`, 6)) {
      const embed = new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle('⚠️ SUSPICIOUS ACTIVITY')
        .setDescription(
          `<@${r.discord_id}>\n5 win beruntun • rata-rata MMR lawan **${Math.round(avgOpp)}** • MMR sekarang **${mine}**`
        );
      await sendAdmin(client, {
        embeds: [embed],
        components: [freezeRow([{ id: r.discord_id, name: await nameOf(client, r.discord_id) }])],
      });
    }
  }
}

// Pola mencurigakan #2: win trading / boosting antar pasangan pemain yang sama.
// Pasangan = Killer vs Survivor yang berulang kali bertemu di sisi berlawanan.
async function checkPairs(client, matchId) {
  const players = db.prepare('SELECT discord_id, role FROM match_players WHERE match_id=?').all(matchId);
  const killer = players.find((p) => p.role === 'killer');
  if (!killer) return;
  const since = nowSec() - cfg.pairWindowDays * 86400;

  for (const s of players.filter((p) => p.role === 'survivor')) {
    const rows = db
      .prepare(
        `SELECT m.winner, a.role AS a_role
         FROM matches m
         JOIN match_players a ON a.match_id = m.id AND a.discord_id = ?
         JOIN match_players b ON b.match_id = m.id AND b.discord_id = ?
         WHERE m.status='verified' AND a.role <> b.role AND m.finished_at >= ?
         ORDER BY m.id`
      )
      .all(killer.discord_id, s.discord_id, since);

    if (rows.length < cfg.pairMinMeetings) continue;

    // 1 = pemain A (killer di match ini) menang pada pertemuan itu
    const aWins = rows.map((r) => (r.winner === r.a_role ? 1 : 0));
    const ratio = aWins.reduce((a, b) => a + b, 0) / aWins.length;
    const tail = aWins.slice(-4);
    const alternating = tail.length === 4 && tail.every((v, i) => i === 0 || v !== tail[i - 1]);
    const lopsided = ratio >= cfg.pairLopsided || ratio <= 1 - cfg.pairLopsided;

    if (!lopsided && !alternating) continue;

    const [x, y] = [killer.discord_id, s.discord_id].sort();
    if (!shouldAlert(`pair:${x}:${y}`, cfg.pairAlertCooldownHours)) continue;

    const nameA = await nameOf(client, killer.discord_id);
    const nameB = await nameOf(client, s.discord_id);
    const reasons = [];
    if (lopsided) reasons.push(`Hasil sangat berat sebelah (${Math.round(ratio * 100)}% dimenangkan <@${killer.discord_id}>) → **boosting**`);
    if (alternating) reasons.push('Hasil bergantian menang-kalah 4 kali terakhir → **win trading**');

    const embed = new EmbedBuilder()
      .setColor(0xc0392b)
      .setTitle('🚩 PAIR ALERT — Possible Win Trading / Boosting')
      .setDescription(
        `<@${killer.discord_id}> ↔ <@${s.discord_id}>\n` +
          `Bertemu **${rows.length}x** di sisi berlawanan dalam ${cfg.pairWindowDays} hari.\n\n` +
          reasons.map((t) => `• ${t}`).join('\n')
      )
      .addFields({ name: 'Riwayat (lama → baru)', value: aWins.map((v) => (v ? '🟢' : '🔴')).join(' ').slice(0, 1000) })
      .setFooter({ text: `🟢 = ${nameA} menang, 🔴 = ${nameB} menang` });

    await sendAdmin(client, {
      embeds: [embed],
      allowedMentions: { parse: [] },
      components: [
        freezeRow([
          { id: killer.discord_id, name: nameA },
          { id: s.discord_id, name: nameB },
        ]),
      ],
    });
  }
}

// ------------------------------------------------------------------ gambar rank-up
async function sendRankCards(client, results, lobby) {
  let target = lobby;
  if (cfg.announceChannelId) {
    const ann = await client.channels.fetch(cfg.announceChannelId).catch(() => null);
    if (ann) target = ann;
  }
  if (!target) return;

  for (const r of results) {
    if (r.frozen || r.after.unranked) continue;
    if (overallLabel(r.before) === overallLabel(r.after)) continue;

    const placement = r.before.unranked;
    if (!placement && r.after.mmr <= r.before.mmr) continue; // rank down: tanpa gambar

    const rk = getRank(r.after.mmr);
    const user = await client.users.fetch(r.discord_id).catch(() => null);
    const png = renderRankCard({
      name: user ? user.username : 'PLAYER',
      tier: rk.tier,
      division: rk.division,
      fromMmr: placement ? null : r.before.mmr,
      toMmr: r.after.mmr,
      kind: placement ? 'placement' : 'rankup',
    });
    if (!png) continue;

    const fname = `rank-${r.discord_id}.png`;
    const embed = new EmbedBuilder()
      .setColor(parseInt(rk.tier.color.slice(1), 16))
      .setDescription(
        placement
          ? `🎯 <@${r.discord_id}> menyelesaikan placement di **${rk.label}**!`
          : `🎉 <@${r.discord_id}> naik ke **${rk.label}**!`
      )
      .setImage(`attachment://${fname}`);
    await target
      .send({ embeds: [embed], files: [new AttachmentBuilder(png, { name: fname })], allowedMentions: { parse: [] } })
      .catch((err) => console.warn('[rankcard] gagal kirim:', err.message));
  }
}

// ------------------------------------------------------------------ hasil final
async function resolveMatch(client, matchId, winner) {
  const res = finalizeMatch(matchId, winner);
  if (!res) return null;

  const lines = res.results.map((r) => {
    const icon = r.role === 'killer' ? '🔪' : '🏃';
    const dot = r.won ? '🟢' : '🔴';

    if (r.frozen) {
      return `${dot} ${icon} <@${r.discord_id}> 🧊 MMR dibekukan — tidak berubah (${r.mmr})`;
    }

    const sign = r.delta >= 0 ? '+' : '';
    const a = overallLabel(r.before);
    const b = overallLabel(r.after);
    let extra = '';
    if (a !== b && !r.after.unranked) {
      if (r.before.unranked) extra = ' 🎉 **PLACEMENT COMPLETE**';
      else extra = r.after.mmr > r.before.mmr ? ' 🎉 **RANK UP**' : ' 📉 **RANK DOWN**';
    }
    const change = a !== b ? `\n　${a} ➜ ${b}` : '';
    return `${dot} ${icon} <@${r.discord_id}> ${r.mmr - r.delta} → **${r.mmr}** (${sign}${r.delta}) • +${r.rp} RP${extra}${change}`;
  });

  const embed = new EmbedBuilder()
    .setColor(winner === 'killer' ? 0xe74c3c : 0x2ecc71)
    .setTitle(`🏆 ${matchTag(matchId)} — ${winner === 'killer' ? '🔪 KILLER' : '🏃 SURVIVOR'} MENANG`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Hasil terverifikasi. Channel ini akan dihapus otomatis.' });

  const lobby = await lobbyOf(client, matchId);
  if (lobby) {
    try {
      await lobby.send({ embeds: [embed] });
      setTimeout(() => lobby.delete('Match selesai').catch(() => {}), cfg.lobbyDeleteMs);
    } catch (err) {
      console.warn('[match] gagal kirim hasil ke lobby:', err.message);
    }
  }

  for (const r of res.results) if (!r.frozen) await syncRank(client, r.discord_id, r.after);
  await sendRankCards(client, res.results, lobby);
  await checkSuspicious(client, res.results);
  await checkPairs(client, matchId);
  return res;
}

// ------------------------------------------------------------------ void & dispute (dipakai admin dan timeout)
async function voidMatch(client, matchId, reason) {
  const r = db
    .prepare("UPDATE matches SET status='void', finished_at=strftime('%s','now') WHERE id=? AND status IN ('active','disputed')")
    .run(matchId);
  if (!r.changes) return false;

  const lobby = await lobbyOf(client, matchId);
  if (lobby) {
    try {
      await lobby.send(`🗑️ **${matchTag(matchId)}** di-void. ${reason || ''} MMR tidak berubah.`);
      setTimeout(() => lobby.delete('Match void').catch(() => {}), cfg.lobbyDeleteMs);
    } catch {}
  }
  return true;
}

async function disputeMatch(client, matchId, reason) {
  const r = db.prepare("UPDATE matches SET status='disputed' WHERE id=? AND status='active'").run(matchId);
  if (!r.changes) return false;

  const lobby = await lobbyOf(client, matchId);
  if (lobby) {
    try {
      await lobby.send(`⚠️ **${matchTag(matchId)}** masuk dispute. Upload screenshot hasil match di sini agar admin bisa memeriksa.`);
    } catch {}
  }
  await disputeAlert(client, matchId, reason);
  return true;
}

// ------------------------------------------------------------------ interaksi
// Pemain menekan tombol hasil di lobby
async function handleVote(interaction, winner, matchId, client) {
  await interaction.deferReply({ flags: EPHEMERAL });

  const m = db.prepare('SELECT * FROM matches WHERE id=?').get(matchId);
  if (!m || m.status !== 'active') return interaction.editReply('Match ini sudah selesai atau tidak aktif.');

  const me = db.prepare('SELECT * FROM match_players WHERE match_id=? AND discord_id=?').get(matchId, interaction.user.id);
  if (!me) return interaction.editReply('❌ Kamu bukan pemain di match ini.');
  if (me.vote) return interaction.editReply(`Kamu sudah submit: **${me.vote}**. Vote tidak bisa diubah.`);

  db.prepare('UPDATE match_players SET vote=? WHERE match_id=? AND discord_id=?').run(winner, matchId, interaction.user.id);

  const counts = db
    .prepare('SELECT vote, COUNT(*) AS c FROM match_players WHERE match_id=? AND vote IS NOT NULL GROUP BY vote')
    .all(matchId);
  const total = counts.reduce((a, x) => a + x.c, 0);
  const top = counts.find((x) => x.c >= cfg.votesNeeded);

  if (top) {
    await interaction.editReply(`✅ Vote tercatat. Hasil terverifikasi: **${top.vote}** menang.`);
    await resolveMatch(client, matchId, top.vote);
    return;
  }

  const playerCount = cfg.survivorsPerMatch + 1;
  if (total >= playerCount) {
    await interaction.editReply('⚠️ Hasil berbeda-beda. Match masuk **dispute**, menunggu admin.');
    await disputeMatch(client, matchId, 'Result dispute (vote tidak sepakat)');
    return;
  }

  await interaction.editReply(`✅ Vote tercatat (${total}/${playerCount}). Menunggu pemain lain.`);
}

// Admin menekan tombol resolve di channel admin
async function handleAdmin(interaction, action, matchId, client) {
  if (!isMod(interaction)) {
    return interaction.reply({ content: '❌ Hanya admin/mod.', flags: EPHEMERAL });
  }
  await interaction.deferReply({ flags: EPHEMERAL });

  if (action === 'void') {
    const ok = await voidMatch(client, matchId, 'Di-void oleh admin.');
    if (!ok) return interaction.editReply('Match sudah diproses.');
    await interaction.message.edit({ components: [] }).catch(() => {});
    return interaction.editReply(`🗑️ ${matchTag(matchId)} di-void.`);
  }

  const res = await resolveMatch(client, matchId, action);
  if (!res) return interaction.editReply('Match sudah diproses.');
  await interaction.message.edit({ components: [] }).catch(() => {});
  return interaction.editReply(`✅ ${matchTag(matchId)} → **${action}** menang. MMR diperbarui.`);
}

// Tombol Freeze / Unfreeze MMR: f:freeze:<userId> | f:unfreeze:<userId>
async function handleFreezeButton(interaction, action, userId) {
  if (!isMod(interaction)) {
    return interaction.reply({ content: '❌ Hanya admin/mod.', flags: EPHEMERAL });
  }
  await interaction.deferReply({ flags: EPHEMERAL });

  if (action === 'unfreeze') {
    clearFrozen(userId);
    return interaction.editReply(`✅ MMR <@${userId}> dibuka kembali.`);
  }
  setFrozen(userId, `Freeze via alert oleh ${interaction.user.username}`, interaction.user.id);
  return interaction.editReply(
    `🧊 MMR <@${userId}> **dibekukan**. Pemain dikeluarkan dari queue dan tidak bisa antre sampai di-unfreeze (\`/unfreeze\`).`
  );
}

module.exports = {
  resultButtons,
  freezeRow,
  handleVote,
  handleAdmin,
  handleFreezeButton,
  resolveMatch,
  voidMatch,
  disputeMatch,
  sendAdmin,
  isMod,
  nameOf,
};
