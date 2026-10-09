const { Client, GatewayIntentBits, MessageFlags, REST, Routes } = require('discord.js');
const cfg = require('./config');
const { commands, handleVerifyConfirm } = require('./commands');
const { runMatchmaking, handleQueueButton } = require('./matchmaking');
const { handleVote, handleAdmin, handleFreezeButton } = require('./matches');
const { handlePartyButton } = require('./party');
const { sweepMatches } = require('./timeouts');
const { startLive } = require('./queueLive');

if (!cfg.token || !cfg.guildId) {
  console.error('DISCORD_TOKEN dan GUILD_ID wajib diisi (Variables di Railway / .env)');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Daftarkan semua slash command ke server (dijalankan otomatis tiap bot start)
async function registerCommands(clientId) {
  try {
    const body = [...commands.values()].map((c) => c.data.toJSON());
    const rest = new REST({ version: '10' }).setToken(cfg.token);
    await rest.put(Routes.applicationGuildCommands(clientId, cfg.guildId), { body });

    // Baca balik dari Discord untuk memastikan command benar-benar tersimpan
    const live = await rest.get(Routes.applicationGuildCommands(clientId, cfg.guildId));
    console.log(`✅ ${body.length} command dikirim, ${live.length} aktif di server ${cfg.guildId}:`);
    console.log(live.map((c) => c.name).sort().join(', '));
  } catch (err) {
    console.error('[register] gagal daftar command:', err);
  }
}

client.once('clientReady', async () => {
  console.log(`🔥 VDP Ranked online sebagai ${client.user.tag}`);

  await registerCommands(client.user.id);

  // Matchmaking berkala: jarak MMR yang diizinkan melebar seiring waktu antre
  setInterval(() => runMatchmaking(client), cfg.matchmakingIntervalMs);
  // Timeout match: pengingat, void otomatis, atau dispute
  setInterval(() => sweepMatches(client), cfg.sweepIntervalMs);
  runMatchmaking(client);
  sweepMatches(client);
  // Status queue live: perbarui pesan penunggu & panel secara otomatis
  startLive(client);
});

client.on('interactionCreate', async (i) => {
  try {
    if (i.isChatInputCommand()) {
      const cmd = commands.get(i.commandName);
      if (cmd) await cmd.execute(i, client);
      return;
    }

    if (i.isButton()) {
      const [kind, a, b, c] = i.customId.split(':');
      if (kind === 'q') return await handleQueueButton(i, a, client);
      if (kind === 'r') return await handleVote(i, a, Number(b), client);
      if (kind === 'a') return await handleAdmin(i, a, Number(b), client);
      if (kind === 'v') return await handleVerifyConfirm(i);
      if (kind === 'p') return await handlePartyButton(i, a, b, c); // p:accept|decline:<partyId>:<userId>
      if (kind === 'f') return await handleFreezeButton(i, a, b); // f:freeze|unfreeze:<userId>
    }
  } catch (err) {
    console.error('[interaction] error:', err);
    const msg = '❌ Terjadi error. Coba lagi sebentar lagi.';
    try {
      if (i.deferred || i.replied) await i.editReply({ content: msg, embeds: [], components: [] });
      else await i.reply({ content: msg, flags: MessageFlags.Ephemeral });
    } catch {}
  }
});

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

client.login(cfg.token);
