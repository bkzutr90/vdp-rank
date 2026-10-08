const { EmbedBuilder } = require('discord.js');
const cfg = require('./config');
const { db, getSeason, getStat, overall, getRp, isFrozen } = require('./db');
const { getRank } = require('./ranks');

const bar = (n, t) => '█'.repeat(Math.min(n, t)) + '░'.repeat(Math.max(0, t - n));

function overallLabel(ov) {
  return ov.unranked ? '🪵 Unranked' : getRank(ov.mmr).label;
}

function roleBlock(icon, name, s) {
  if (s.games < cfg.placementGames) {
    return `${icon} **${name}**\n🪵 Placement ${bar(s.games, cfg.placementGames)} ${s.games}/${cfg.placementGames}`;
  }
  const wr = s.games ? Math.round((s.wins / s.games) * 100) : 0;
  return `${icon} **${name}**\n${getRank(s.mmr).label} — **${s.mmr}** MMR\nWin Rate: ${wr}% • W ${s.wins} / L ${s.losses}`;
}

function rankEmbed(user) {
  const id = user.id;
  const k = getStat(id, 'killer');
  const s = getStat(id, 'survivor');
  const ov = overall(id);
  const rp = getRp(id);
  const rb = db.prepare('SELECT roblox_name FROM users WHERE discord_id=?').get(id);
  const frozen = isFrozen(id);

  const wins = k.wins + s.wins;
  const games = k.games + s.games;
  const wr = games ? Math.round((wins / games) * 100) : 0;

  const embed = new EmbedBuilder()
    .setColor(frozen ? 0x95a5a6 : 0xe74c3c)
    .setTitle(`🔥 ${user.username}`)
    .setDescription(
      `**${overallLabel(ov)}**${ov.unranked ? '' : ` — **${ov.mmr}** MMR`}\n` +
        (rb ? `Roblox: **${rb.roblox_name}** ✅` : 'Roblox: belum verifikasi (`/verify`)') +
        (frozen ? '\n🧊 **MMR dibekukan** — sedang ditinjau admin' : '')
    )
    .addFields(
      { name: '\u200b', value: roleBlock('🔪', 'Killer', k), inline: true },
      { name: '\u200b', value: roleBlock('🏃', 'Survivor', s), inline: true },
      {
        name: 'Statistik',
        value:
          `W ${wins} • L ${games - wins} • WR ${wr}%\n` +
          `🔥 Win Streak: ${Math.max(k.streak, s.streak)}\n` +
          (games ? `📈 Peak: ${Math.max(k.peak, s.peak)} MMR\n` : '📈 Peak: -\n') +
          `💰 Ranked Points: **${rp.season}** (season) • ${rp.total} (total)`,
      }
    )
    .setFooter({ text: `Season ${getSeason()}` });

  return embed;
}

module.exports = { rankEmbed, overallLabel, bar };
