const { REST, Routes } = require('discord.js');
const cfg = require('./config');
const { commands } = require('./commands');

(async () => {
  if (!cfg.token || !cfg.clientId || !cfg.guildId) {
    console.error('DISCORD_TOKEN, CLIENT_ID, dan GUILD_ID wajib diisi di .env');
    process.exit(1);
  }
  const body = [...commands.values()].map((c) => c.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(cfg.token);
  await rest.put(Routes.applicationGuildCommands(cfg.clientId, cfg.guildId), { body });
  console.log(`✅ ${body.length} slash command terdaftar di server ${cfg.guildId}`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
