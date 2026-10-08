const cfg = require('./config');
const { TIERS, getRank } = require('./ranks');

const PREFIX = 'VDP ';
const roleName = (tierName) => `${PREFIX}${tierName}`;

// Sinkronkan role Discord sesuai rank keseluruhan. Butuh permission Manage Roles,
// dan role bot harus berada di atas role "VDP ..." di daftar role server.
async function syncRank(client, discordId, ov) {
  try {
    const guild = await client.guilds.fetch(cfg.guildId);
    const member = await guild.members.fetch(discordId);
    await guild.roles.fetch();

    const allNames = TIERS.map((t) => roleName(t.name));

    if (ov.unranked) {
      const stale = member.roles.cache.filter((r) => allNames.includes(r.name));
      if (stale.size) await member.roles.remove(stale);
      return;
    }

    const targetName = roleName(getRank(ov.mmr).tier.name);
    let role = guild.roles.cache.find((r) => r.name === targetName);
    if (!role) role = await guild.roles.create({ name: targetName, reason: 'VDP Ranked rank role' });

    const remove = member.roles.cache.filter((r) => allNames.includes(r.name) && r.name !== targetName);
    if (remove.size) await member.roles.remove(remove);
    if (!member.roles.cache.has(role.id)) await member.roles.add(role);
  } catch (err) {
    console.warn(`[roles] gagal sync role ${discordId}:`, err.message);
  }
}

module.exports = { syncRank };
